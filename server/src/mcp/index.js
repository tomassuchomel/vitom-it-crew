// MCP server exposující interní tickety (úkoly) externímu Claudovi
// (Cowork, Claude Code, apod.) přes Streamable HTTP.
//
// Ticket == náš tasks řádek. „Pro Clauda" znamená tasks.ai_assignee = TRUE.
// Workflow mapa na naše statuses:
//   backlog     ↔ 'todo'         (ještě nezvedl programátor)
//   todo        ↔ 'todo'         (identické; alias pro MCP klienta)
//   in_progress ↔ 'in_progress'
//   in_review   ↔ 'review'
//   done        ↔ 'done'
//   blocked     ↔ 'needs_fix'    (nejbližší analogie „zablokované, čeká na akci")
//
// Autentizace: každý request musí mít `Authorization: Bearer <MCP_AUTH_TOKEN>`.
// Bez tokenu → 401. Token je čistě env var, do gitu nikdy.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { verifyMcpToken } from '../routes/mcp-tokens.js';

// Mapa MCP status ↔ naše tasks.status.
const MCP_TO_DB = {
  backlog:     'todo',
  todo:        'todo',
  in_progress: 'in_progress',
  in_review:   'review',
  done:        'done',
  blocked:     'needs_fix',
};
const DB_TO_MCP = {
  todo:        'todo',
  in_progress: 'in_progress',
  review:      'in_review',
  done:        'done',
  needs_fix:   'blocked',
};

// Povolené přechody (MCP semantics)
const ALLOWED_TRANSITIONS = {
  backlog:     ['todo', 'blocked'],
  todo:        ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked', 'done'],
  in_review:   ['done', 'in_progress', 'blocked'],
  blocked:     ['todo', 'in_progress'],
  done:        [],
};

// Globální pravidla, kterými se má Claude řídit při práci na ticketech.
// Můžeš je později přesunout do DB / env.
const GLOBAL_RULES = `\
1. Než začneš na ticketu pracovat, zavolej get_ticket a pročti si acceptanceCriteria.
2. Po každém dílčím kroku přidej stručný komentář přes add_comment.
3. Když narazíš na blocker, přesuň ticket do 'blocked' a napiš důvod komentářem.
4. Ticket je hotový teprve když splňuje všechna acceptance criteria. Pak 'in_review'.
5. Nikdy neposouvej stav zpět bez souhlasu (through comment first).
6. Pokud ticket není přiřazený tobě (assignee != 'claude'), NEclaimuj ho.`;

// ==================== SDK helpery ====================

// Vytvoří novou McpServer instanci s všemi tools zaregistrovanými.
// Voláno per request (stateless mode) — každý request = fresh server + transport.
//
// mcpUser: { global: true } → vidí a mění všechny tickety
//          { userId: N }    → vidí a mění jen svoje úkoly (assignee_id = N)
function buildMcpServer(mcpUser = { global: true }) {
  const server = new McpServer(
    { name: 'vitom-tickets', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // --- list_tickets ---
  server.registerTool(
    'list_tickets',
    {
      description: "Seznam ticketů. Výchozí filtr: status='todo' a assignee='claude'.",
      inputSchema: {
        status:   z.string().optional().describe("MCP status: backlog|todo|in_progress|in_review|done|blocked"),
        assignee: z.string().optional().describe("Assignee identifier. 'claude' = tickety pro AI agenta."),
        limit:    z.number().int().min(1).max(200).optional().describe("Max počet výsledků (default 50)."),
      },
    },
    async (args) => {
      const statusMcp = args.status ?? 'todo';
      // Per-user token → default filter = jeho úkoly. Global token → default 'claude'.
      const assignee  = args.assignee ?? (mcpUser.userId ? String(mcpUser.userId) : 'claude');
      const limit     = args.limit ?? 50;

      const dbStatus = MCP_TO_DB[statusMcp];
      if (!dbStatus) {
        return { content: [{ type: 'text', text: `Invalid status: ${statusMcp}` }], isError: true };
      }

      // Per-user token: vždy filter na jeho assignee_id, ignoruje argument assignee
      // (bezpečnostní gate — user nemá vidět cizí úkoly).
      const params = [dbStatus];
      let assigneeFilter;
      if (mcpUser.userId) {
        params.push(mcpUser.userId);
        assigneeFilter = `t.assignee_id = $${params.length}`;
      } else if (assignee === 'claude') {
        assigneeFilter = `t.ai_assignee = TRUE`;
      } else if (/^\d+$/.test(String(assignee))) {
        params.push(Number(assignee));
        assigneeFilter = `t.assignee_id = $${params.length}`;
      } else {
        assigneeFilter = `TRUE`;
      }

      params.push(limit);
      const r = await query(`
        SELECT t.id, t.title, t.status, t.priority, t.description,
               p.name AS project_name
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.status = $1 AND ${assigneeFilter}
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
          t.id
        LIMIT $${params.length}
      `, params);

      const tickets = r.rows.map(row => ({
        id: row.id,
        title: row.title,
        status: DB_TO_MCP[row.status] || row.status,
        priority: row.priority,
        order: row.id, // aktuální schéma nemá explicit order, používáme id
        labels: [row.project_name].filter(Boolean),
        shortDescription: row.description ? String(row.description).slice(0, 200) : '',
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ tickets }, null, 2) }] };
    }
  );

  // --- get_ticket ---
  server.registerTool(
    'get_ticket',
    {
      description: 'Plný detail ticketu vč. acceptance criteria a globálních pravidel.',
      inputSchema: { id: z.number().int().min(1) },
    },
    async ({ id }) => {
      const r = await query(`
        SELECT t.*, p.name AS project_name
        FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1
      `, [id]);
      const row = r.rows[0];
      if (!row) return { content: [{ type: 'text', text: `Ticket ${id} nenalezen` }], isError: true };
      // Per-user token: vidí jen svoje úkoly (kde je assignee).
      if (mcpUser.userId && row.assignee_id !== mcpUser.userId) {
        return { content: [{ type: 'text', text: `Ticket ${id} není přiřazen tobě.` }], isError: true };
      }

      // Komentáře čerpáme z task_reviews (review workflow komentáře).
      const c = await query(`
        SELECT tr.verdict, tr.comment, tr.created_at, u.name AS author
        FROM task_reviews tr LEFT JOIN users u ON u.id = tr.reviewer_id
        WHERE tr.task_id = $1 ORDER BY tr.created_at ASC
      `, [id]);

      const acceptance = Array.isArray(row.acceptance_criteria)
        ? row.acceptance_criteria
        : (row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) : []);

      const ticket = {
        id: row.id,
        title: row.title,
        description: row.description || '',
        acceptanceCriteria: acceptance,
        rules: GLOBAL_RULES,
        status: DB_TO_MCP[row.status] || row.status,
        priority: row.priority,
        labels: [row.project_name].filter(Boolean),
        comments: c.rows.map(cr => ({
          author: cr.author || 'system',
          body: `[${cr.verdict}] ${cr.comment || ''}`.trim(),
          at: cr.created_at,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
    }
  );

  // --- claim_ticket (idempotentní, atomicky) ---
  // Zajišťuje, že si ticket vezme jen jeden agent. Používáme conditional UPDATE
  // s návratem, kolik řádků bylo zasaženo. Kdyby už byl claimed, vrátíme chybu
  // s aktuálním stavem místo tichého přepisu.
  server.registerTool(
    'claim_ticket',
    {
      description: "Převzít ticket pro Clauda. Atomicky + idempotentně. Chyba, když už není 'todo'.",
      inputSchema: { id: z.number().int().min(1) },
    },
    async ({ id }) => {
      // Idempotence: pokud už je in_progress AND ai_assignee=TRUE, vrátíme OK.
      const cur = await query(`SELECT status, ai_assignee, assignee_id FROM tasks WHERE id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) return { content: [{ type: 'text', text: `Ticket ${id} nenalezen` }], isError: true };
      // Per-user token: může claim jen vlastní úkol.
      if (mcpUser.userId && row.assignee_id !== mcpUser.userId) {
        return { content: [{ type: 'text', text: `Nemůžeš claim cizí ticket ${id}.` }], isError: true };
      }
      if (row.status === 'in_progress' && row.ai_assignee) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, status: 'in_progress', note: 'already_claimed' }) }] };
      }
      if (row.status !== 'todo' || !row.ai_assignee) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false, id,
            current_status: DB_TO_MCP[row.status] || row.status,
            error: 'not_claimable',
            message: `Ticket není ve stavu 'todo' pro Clauda (current: ${row.status}, ai_assignee=${row.ai_assignee}).`,
          }) }],
          isError: true,
        };
      }

      const upd = await query(`
        UPDATE tasks
        SET status = 'in_progress'
        WHERE id = $1 AND status = 'todo' AND ai_assignee = TRUE
        RETURNING id, status
      `, [id]);

      if (upd.rowCount === 0) {
        // Race — někdo jiný to mezi tím vzal.
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, id, error: 'race_lost', message: 'Ticket byl mezitím převzat jiným agentem.' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, status: 'in_progress' }) }] };
    }
  );

  // --- update_ticket_status ---
  server.registerTool(
    'update_ticket_status',
    {
      description: "Změnit stav ticketu (in_progress|in_review|done|blocked). Validace přechodů.",
      inputSchema: {
        id:     z.number().int().min(1),
        status: z.enum(['in_progress', 'in_review', 'done', 'blocked']),
        note:   z.string().max(5000).optional(),
      },
    },
    async ({ id, status, note }) => {
      const cur = await query(`SELECT status, assignee_id FROM tasks WHERE id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) return { content: [{ type: 'text', text: `Ticket ${id} nenalezen` }], isError: true };
      if (mcpUser.userId && row.assignee_id !== mcpUser.userId) {
        return { content: [{ type: 'text', text: `Nemůžeš měnit stav cizího ticketu ${id}.` }], isError: true };
      }
      const fromMcp = DB_TO_MCP[row.status] || row.status;
      if (!ALLOWED_TRANSITIONS[fromMcp]?.includes(status)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_transition', from: fromMcp, to: status }) }],
          isError: true,
        };
      }
      const dbNext = MCP_TO_DB[status];
      const upd = await query(`UPDATE tasks SET status = $1 WHERE id = $2`, [dbNext, id]);
      if (upd.rowCount === 0) {
        return { content: [{ type: 'text', text: 'Update failed (0 rows affected)' }], isError: true };
      }
      if (note) {
        // Zaznamenáme jako task_review s verdikt 'note' (fallback: comment).
        await query(`
          INSERT INTO task_reviews (task_id, reviewer_id, verdict, comment)
          VALUES ($1, NULL, $2, $3)
        `, [id, 'note', note]).catch(() => {});
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, status }) }] };
    }
  );

  // --- add_comment ---
  server.registerTool(
    'add_comment',
    {
      description: 'Přidá komentář k ticketu (postup, nález, dotaz).',
      inputSchema: {
        id:   z.number().int().min(1),
        body: z.string().min(1).max(5000),
      },
    },
    async ({ id, body }) => {
      const cur = await query(`SELECT id, assignee_id FROM tasks WHERE id = $1`, [id]);
      if (!cur.rows[0]) return { content: [{ type: 'text', text: `Ticket ${id} nenalezen` }], isError: true };
      if (mcpUser.userId && cur.rows[0].assignee_id !== mcpUser.userId) {
        return { content: [{ type: 'text', text: `Nemůžeš komentovat cizí ticket ${id}.` }], isError: true };
      }

      const ins = await query(`
        INSERT INTO task_reviews (task_id, reviewer_id, verdict, comment)
        VALUES ($1, NULL, 'comment', $2)
        RETURNING id, created_at
      `, [id, body]);
      if (ins.rowCount === 0) {
        return { content: [{ type: 'text', text: 'Insert failed' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, comment_id: ins.rows[0].id }) }] };
    }
  );

  // --- get_rules ---
  server.registerTool(
    'get_rules',
    { description: 'Globální pravidla pro práci s tickety.' },
    async () => ({ content: [{ type: 'text', text: GLOBAL_RULES }] })
  );

  return server;
}

// ==================== Express handler ====================

// Bearer auth middleware. Přijímá dva typy tokenů:
//   1) MCP_AUTH_TOKEN (env var) → "admin" režim, vidí a mění všechny tickety.
//      Používáme na server-to-server integrace / development.
//   2) Per-user token z tabulky user_mcp_tokens → user vidí a mění JEN
//      svoje úkoly. Vytvořený uživatelem v Profile.
// req.mcpUser = { global: true } nebo { userId: N }.
export async function requireMcpAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'unauthorized' });
  const token = m[1];

  // 1) Global admin token
  const globalToken = process.env.MCP_AUTH_TOKEN;
  if (globalToken && token === globalToken) {
    req.mcpUser = { global: true };
    return next();
  }

  // 2) Per-user token — hash lookup v DB
  const userId = await verifyMcpToken(token);
  if (userId) {
    req.mcpUser = { userId };
    return next();
  }

  return res.status(401).json({ error: 'unauthorized' });
}

// Stateless handler — každý request si vytvoří vlastní server+transport.
// Vhodné pro jednoduché MCP tools bez session state.
export async function handleMcpRequest(req, res) {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close?.(); });
    // req.mcpUser byl nastaven middlewarem requireMcpAuth.
    const server = buildMcpServer(req.mcpUser);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] handler error', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
  }
}

// Public export pro testy (nechceme startovat HTTP server).
export { buildMcpServer, MCP_TO_DB, DB_TO_MCP, ALLOWED_TRANSITIONS, GLOBAL_RULES };
