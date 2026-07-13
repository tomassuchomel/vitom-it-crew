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

// Sečti řádky { team_id, n } do { total, byTeam }. Řádky bez team_id
// (legacy úkoly / dotazy bez projektu) přeskočíme úplně, aby platilo
// total = suma byTeam — jinak by badge ukazoval jiné číslo než submenu.
function bucket(rows) {
  const byTeam = {};
  let total = 0;
  for (const r of rows) {
    if (r.team_id == null) continue;
    const n = Number(r.n) || 0;
    total += n;
    byTeam[r.team_id] = (byTeam[r.team_id] || 0) + n;
  }
  return { total, byTeam };
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

  const [rq, nf, inbox, answ, mine] = await Promise.all([
    reviewQ, needsFixQ, inboxQ, answersQ, myTasksQ,
  ]);

  res.json({
    reviewQueue:   bucket(rq.rows),
    needsFix:      bucket(nf.rows),
    inboxPending:  bucket(inbox.rows),
    answersUnread: bucket(answ.rows),
    myTasks:       bucket(mine.rows),
  });
});

export default router;
