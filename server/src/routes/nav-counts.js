// Sjednocené počty pro badge v levém menu.
//
// Nahrazuje 3 samostatná volání (questions/counts, review-queue, needs-fix)
// jedním request a přidává rozpad per tým — abychom v rozbaleném submenu
// (Vše / IT / Management / …) uměli u každého týmu ukázat jeho číslo.
//
// Vrací pro každou kategorii { total, byTeam: { <team_id>: <count> } }:
//   reviewQueue    – úkoly ve stavu 'review', kde je user manager/admin
//   needsFix       – moje úkoly ve stavu 'needs_fix'
//   inboxPending   – dotazy na mě (to_user_id, status='pending')
//   answersUnread  – odpovězené moje dotazy nepřečtené (from_user_id,
//                    status='answered', answer_read=FALSE)
//   myTasks        – moje nedokončené (todo/in_progress/needs_fix)
//
// Rozpad po týmech ber přes projects.team_id (u dotazu přes task→project,
// jinak přes přímé question.project_id). Řádky bez team_id ignorujeme.

import { Router } from 'express';
import { requireAuth, can } from '../auth.js';
import { query } from '../db.js';

const router = Router();

// Sečti řádky { team_id, n } do { total, byTeam, other }.
// Řádky bez team_id (legacy úkoly / dotazy bez projektu) přeskočíme.
// Řádky z týmu, kde user NENÍ členem (cross-team subtask assignee, cizí manager)
// jdou do `other` — v UI se ukážou jako „Ostatní" a součet byTeam + other = total.
// Admin (adminAll=true) vidí všechno v byTeam a `other` je vždy 0.
function bucket(rows, memberTeams, adminAll) {
  const byTeam = {};
  let total = 0, other = 0;
  for (const r of rows) {
    if (r.team_id == null) continue;
    const n = Number(r.n) || 0;
    total += n;
    if (adminAll || memberTeams.has(r.team_id)) {
      byTeam[r.team_id] = (byTeam[r.team_id] || 0) + n;
    } else {
      other += n;
    }
  }
  return { total, byTeam, other };
}

router.get('/', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const isAdmin = req.user.role === 'admin';
  const canReview = can.manageProjects(req.user);

  // reviewQueue: úkoly ve stavu 'review', kde je user manager projektu / admin.
  // Když user nemá manageProjects → prázdno.
  const reviewQ = canReview
    ? (isAdmin
        ? query(`
            SELECT p.team_id, COUNT(*)::int AS n
            FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE t.status = 'review'
            GROUP BY p.team_id
          `)
        : query(`
            SELECT p.team_id, COUNT(*)::int AS n
            FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE t.status = 'review' AND p.manager_id = $1
            GROUP BY p.team_id
          `, [uid]))
    : Promise.resolve({ rows: [] });

  // needsFix: moje úkoly ve stavu 'needs_fix' (assignee = já).
  const needsFixQ = query(`
    SELECT p.team_id, COUNT(*)::int AS n
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = $1 AND t.status = 'needs_fix'
    GROUP BY p.team_id
  `, [uid]);

  // inboxPending: dotazy na mě, status pending. team_id přes task→project
  // nebo přímé question.project_id (COALESCE).
  const inboxQ = query(`
    SELECT COALESCE(pt.team_id, pd.team_id) AS team_id, COUNT(*)::int AS n
    FROM questions q
    LEFT JOIN tasks t   ON t.id  = q.task_id
    LEFT JOIN projects pt ON pt.id = t.project_id
    LEFT JOIN projects pd ON pd.id = q.project_id
    WHERE q.to_user_id = $1 AND q.status = 'pending'
    GROUP BY COALESCE(pt.team_id, pd.team_id)
  `, [uid]);

  // answersUnread: moje dotazy odpovězené, answer_read=FALSE. Defenzivně:
  // sloupec byl přidán migrací 2026-07-02; kdyby ještě nedoběhla, vrátíme 0.
  const answersQ = query(`
    SELECT COALESCE(pt.team_id, pd.team_id) AS team_id, COUNT(*)::int AS n
    FROM questions q
    LEFT JOIN tasks t   ON t.id  = q.task_id
    LEFT JOIN projects pt ON pt.id = t.project_id
    LEFT JOIN projects pd ON pd.id = q.project_id
    WHERE q.from_user_id = $1 AND q.status = 'answered' AND q.answer_read = FALSE
    GROUP BY COALESCE(pt.team_id, pd.team_id)
  `, [uid]).catch(err => {
    if (err.code === '42703') return { rows: [] };
    throw err;
  });

  // myTasks: nedokončené moje úkoly.
  const myTasksQ = query(`
    SELECT p.team_id, COUNT(*)::int AS n
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = $1 AND t.status IN ('todo', 'in_progress', 'needs_fix')
    GROUP BY p.team_id
  `, [uid]);

  // dueRequests: pending žádosti čekající na mě (jako reviewer) + moje
  // vyřešené nepřečtené (souhrnný badge). Defenzivně: tabulka mohla ještě
  // nevzniknout, pokud migrace 2026-07-07 nedoběhla.
  const dueRequestsQ = query(`
    SELECT p.team_id, COUNT(*)::int AS n
    FROM task_due_change_requests r
    JOIN tasks t ON t.id = r.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE (
      (r.reviewer_id = $1 AND r.status = 'pending')
      OR (r.requester_id = $1 AND r.status != 'pending' AND r.seen_by_requester = FALSE)
    )
    GROUP BY p.team_id
  `, [uid]).catch(err => {
    if (err.code === '42P01') return { rows: [] }; // tabulka neexistuje
    throw err;
  });

  // Load member teams — jen týmy, kde je user reálně členem. Admin vidí
  // vše v byTeam (adminAll=true), pro ně memberTeams roli nehraje.
  const memberQ = query(`SELECT team_id FROM team_members WHERE user_id = $1`, [uid]);

  const [rq, nf, inbox, answ, mine, dueReq, mem] = await Promise.all([
    reviewQ, needsFixQ, inboxQ, answersQ, myTasksQ, dueRequestsQ, memberQ,
  ]);
  const memberTeams = new Set(mem.rows.map(r => r.team_id));

  res.json({
    reviewQueue:   bucket(rq.rows,    memberTeams, isAdmin),
    needsFix:      bucket(nf.rows,    memberTeams, isAdmin),
    inboxPending:  bucket(inbox.rows, memberTeams, isAdmin),
    answersUnread: bucket(answ.rows,  memberTeams, isAdmin),
    myTasks:       bucket(mine.rows,  memberTeams, isAdmin),
    dueRequests:   bucket(dueReq.rows, memberTeams, isAdmin),
  });
});

export default router;
