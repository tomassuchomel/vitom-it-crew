// Lifecycle nápadu (sekce 9 zadání).
//
// Nápad přejde na 'hotovo' teprve tehdy, když jsou dokončené VŠECHNY objekty,
// které jeho realizaci představují — navázaný projekt i všechny navázané úkoly.
// Vazby jdou přes ID (ideas.linked_project_id, idea_tasks), ne přes názvy.
//
// Voláme fire-and-forget z tasks.js / projects.js po změně stavu; případná
// chyba nesmí shodit dokončení úkolu.

import { query } from './db.js';

// Přepočítá stav jednoho nápadu. Vrací true, když došlo ke změně na 'hotovo'.
export async function syncIdeaCompletion(ideaId, userId = null) {
  const idea = (await query('SELECT id, state, linked_project_id FROM ideas WHERE id = $1', [ideaId])).rows[0];
  if (!idea) return false;
  // Uzavřené / zamítnuté nápady neoživujeme. Dokončit jde jen rozpracovaný.
  if (idea.state !== 'rozpracovano') return false;

  let total = 0;
  let done = 0;

  if (idea.linked_project_id) {
    const p = (await query('SELECT status FROM projects WHERE id = $1', [idea.linked_project_id])).rows[0];
    if (p) {
      total += 1;
      if (p.status === 'done') done += 1;
    }
  }

  const t = await query(`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status = 'done')::int AS done
    FROM idea_tasks it JOIN tasks t ON t.id = it.task_id
    WHERE it.idea_id = $1
  `, [ideaId]);
  total += t.rows[0].total;
  done += t.rows[0].done;

  // Bez realizace nemáme co dokončovat.
  if (total === 0 || done < total) return false;

  await query(`UPDATE ideas SET state = 'hotovo', updated_at = NOW() WHERE id = $1`, [ideaId]);
  await query(`
    INSERT INTO idea_events (idea_id, action, from_state, to_state, user_id, comment)
    VALUES ($1, 'auto_completed', 'rozpracovano', 'hotovo', $2, $3)
  `, [ideaId, userId, `Všechny navázané realizace (${done}/${total}) jsou hotové.`]);
  return true;
}

// Po změně stavu úkolu přepočítá nápady, které na něm visí.
export async function syncIdeasForTask(taskId, userId = null) {
  const r = await query('SELECT idea_id FROM idea_tasks WHERE task_id = $1', [taskId]);
  for (const row of r.rows) await syncIdeaCompletion(row.idea_id, userId);
}

// Po změně stavu projektu přepočítá nápady, které na něj visí.
export async function syncIdeasForProject(projectId, userId = null) {
  const r = await query('SELECT id FROM ideas WHERE linked_project_id = $1', [projectId]);
  for (const row of r.rows) await syncIdeaCompletion(row.id, userId);
}
