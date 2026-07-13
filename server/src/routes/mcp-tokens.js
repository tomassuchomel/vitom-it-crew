// Správa uživatelských MCP tokenů. Každý user si může vytvořit vlastní
// token pro připojení MCP klienta. Token = 32 náhodných bytů = 43 znaků
// base64url. Server ukládá SHA-256 hash + prefix. Plaintext se ukáže
// jen jednou při vytvoření.

import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = Router();

// SHA-256 hash tokenu (hex).
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Seznam mých tokenů (jen metadata, nikoli plain hodnota).
router.get('/', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT id, token_prefix, name, created_at, last_used_at
    FROM user_mcp_tokens
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [req.user.id]);
  res.json({ tokens: r.rows });
});

// Vytvoří nový token — plaintext vrátí JEN JEDNOU.
router.post('/', requireAuth, async (req, res) => {
  const name = req.body?.name ? String(req.body.name).trim().slice(0, 100) : null;
  const plain = crypto.randomBytes(32).toString('base64url'); // 43 znaků
  const prefix = plain.slice(0, 8);
  const hash = hashToken(plain);

  const r = await query(`
    INSERT INTO user_mcp_tokens (user_id, token_prefix, token_hash, name)
    VALUES ($1, $2, $3, $4)
    RETURNING id, token_prefix, name, created_at
  `, [req.user.id, prefix, hash, name]);

  res.status(201).json({
    ok: true,
    token: plain,      // <-- plain zobrazíme JEN ZDE
    id: r.rows[0].id,
    token_prefix: r.rows[0].token_prefix,
    name: r.rows[0].name,
  });
});

// Smaže vlastní token.
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(
    `DELETE FROM user_mcp_tokens WHERE id = $1 AND user_id = $2`,
    [id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// Interní helper pro MCP middleware — verifikuje token a vrací userId
// (nebo null). Neblokuje na chybě DB — vrátí null, MCP odmítne 401.
export async function verifyMcpToken(plain) {
  try {
    const hash = hashToken(plain);
    const r = await query(
      `SELECT user_id FROM user_mcp_tokens WHERE token_hash = $1`,
      [hash]
    );
    if (!r.rows[0]) return null;
    // Update last_used_at asynchronně — nechceme blokovat request.
    query(`UPDATE user_mcp_tokens SET last_used_at = NOW() WHERE token_hash = $1`, [hash])
      .catch(() => {});
    return r.rows[0].user_id;
  } catch (err) {
    console.warn('[mcp-tokens] verify error', err.message);
    return null;
  }
}

export default router;
