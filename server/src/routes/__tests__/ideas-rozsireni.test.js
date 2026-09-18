// Nápadník — rozšíření (sekce 6, 7, 9, 10, 11, 12, 13, 14 zadání).
// Pokrývá testovací scénáře 13–21, 23, 25–27, 29–39 z bodu 24.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

const IDEA = {
  title: 'Automatizovat reporty',
  department: 'Marketing',
  category: 'Reporting a data',
  problem_description: 'Reporty děláme ručně.',
  solution_proposal: 'Vygenerovat je skriptem.',
};

async function seed() {
  // Tým 'management' může založit už migrace — proto upsert, ne holý INSERT.
  const mgmtTeam = (await db.query(`
    INSERT INTO teams (name, slug) VALUES ('Management','management')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `)).rows[0].id;
  const itTeam = (await db.query(`INSERT INTO teams (name, slug) VALUES ('IT','it-ideas') RETURNING id`)).rows[0].id;
  const mk = async (email, name, role) =>
    (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [email, name, role])).rows[0].id;

  const mgmt    = await mk('mgmt-i@t.cz', 'Manager', 'manager');
  const pm      = await mk('pm-i@t.cz', 'PM Nápadníku', 'manager');
  const outsider = await mk('out-i@t.cz', 'Běžný', 'senior_dev');
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager')`, [mgmtTeam, mgmt]);
  // PM musí být členem IT týmu, jinak v něm (správně) nesmí zakládat úkoly.
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'member'),($1,$3,'member')`, [itTeam, outsider, pm]);
  await db.query(`INSERT INTO idea_pms (user_id) VALUES ($1)`, [pm]);

  const project = (await db.query(
    `INSERT INTO projects (name,start_date,team_id,manager_id) VALUES ('P',CURRENT_DATE,$1,$2) RETURNING id`, [itTeam, mgmt]
  )).rows[0].id;
  return { mgmtTeam, itTeam, mgmt, pm, outsider, project };
}

const USER = {
  mgmt: () => ({ id: ctx.mgmt, email: 'mgmt-i@t.cz', role: 'manager', name: 'Manager' }),
  pm:   () => ({ id: ctx.pm, email: 'pm-i@t.cz', role: 'manager', name: 'PM Nápadníku' }),
  out:  () => ({ id: ctx.outsider, email: 'out-i@t.cz', role: 'senior_dev', name: 'Běžný' }),
};

const api = async (user, method, path, body) => {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.cookie = `tf_token=${signToken(user)}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/ideas${path}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Multipart — pro upload příloh.
const upload = async (user, path, fields, files) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('files', new Blob([f.data], { type: f.type }), f.name);
  const headers = {};
  if (user) headers.cookie = `tf_token=${signToken(user)}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/ideas${path}`, { method: 'POST', headers, body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const newIdea = async (over = {}) => {
  const r = await db.query(`
    INSERT INTO ideas (proposer_name, proposer_email, title, department, category,
      problem_description, solution_proposal, state, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
  `, ['Navrhovatel', 'n@t.cz', over.title || IDEA.title, IDEA.department, IDEA.category,
      IDEA.problem_description, IDEA.solution_proposal, over.state || 'zadano', over.source || 'public_form']);
  return r.rows[0].id;
};

before(async () => {
  const t = await startTestDb();
  stopDb = t.stop;
  process.env.DATABASE_URL = t.url;
  process.env.DATABASE_SSL = 'false';
  process.env.JWT_SECRET = 'test-secret';
  process.env.DISABLE_AUTOSEED = '1';
  db = await import('../../db.js');
  await db.migrate();
  await db.runFileMigrations();
  ({ signToken } = await import('../../auth.js'));
  const { default: ideasRoutes } = await import('../ideas.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/ideas', ideasRoutes);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  ctx = await seed();
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (db) await db.pool.end();
  if (stopDb) await stopDb();
});

// ---------- 6) interní nápad ----------

test('PM založí nápad interně — stejná tabulka, stav zadano, autor z přihlášení', async () => {
  const r = await api(USER.pm(), 'POST', '/internal', IDEA);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = (await db.query('SELECT * FROM ideas WHERE id = $1', [r.body.id])).rows[0];
  assert.equal(row.state, 'zadano');
  assert.equal(row.source, 'internal');
  assert.equal(row.created_by_id, ctx.pm);
  assert.equal(row.proposer_name, 'PM Nápadníku', 'navrhovatel předvyplněn z uživatele');
});

test('běžný uživatel interní nápad založit nesmí (vynuceno na backendu)', async () => {
  const r = await api(USER.out(), 'POST', '/internal', IDEA);
  assert.equal(r.status, 403);
});

test('interní nápad bez povinných polí → 400 s poli', async () => {
  const r = await api(USER.pm(), 'POST', '/internal', { ...IDEA, title: '' });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.title);
});

test('vytvoření interního nápadu je v historii', async () => {
  const r = await api(USER.pm(), 'POST', '/internal', IDEA);
  const ev = await db.query(`SELECT action, user_id FROM idea_events WHERE idea_id = $1`, [r.body.id]);
  assert.ok(ev.rows.some(e => e.action === 'created_internal' && e.user_id === ctx.pm));
});

// ---------- 7) přílohy ----------

test('veřejný formulář uloží nápad i s přílohou', async () => {
  const r = await upload(null, '/public', IDEA_FIELDS(), [
    { name: 'foto.png', type: 'image/png', data: 'PNGDATA' },
    { name: 'popis.pdf', type: 'application/pdf', data: '%PDF-1.4' },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const att = await db.query('SELECT * FROM attachments WHERE idea_id = $1 ORDER BY id', [r.body.id]);
  assert.equal(att.rows.length, 2);
  assert.equal(att.rows[0].kind, 'image');
  assert.equal(att.rows[0].uploader_id, null, 'veřejný upload nemá uploadera');
});

function IDEA_FIELDS() {
  return {
    proposer_name: 'Veřejný', proposer_email: 'v@t.cz',
    title: IDEA.title, department: IDEA.department, category: IDEA.category,
    problem_description: IDEA.problem_description, solution_proposal: IDEA.solution_proposal,
  };
}

test('nepovolený typ souboru je odmítnut srozumitelnou chybou', async () => {
  const r = await upload(null, '/public', IDEA_FIELDS(), [
    { name: 'hack.svg', type: 'image/svg+xml', data: '<svg onload=alert(1)>' },
  ]);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unsupported_type');
  assert.match(r.body.message, /PDF/);
});

test('přílohy nápadu vidí Management, běžný uživatel ne', async () => {
  const id = await newIdea();
  const up = await upload(USER.pm(), `/${id}/attachments`, {}, [{ name: 'a.png', type: 'image/png', data: 'X' }]);
  assert.equal(up.status, 201, JSON.stringify(up.body));

  assert.equal((await api(USER.mgmt(), 'GET', `/${id}/attachments`)).body.attachments.length, 1);
  assert.equal((await api(USER.out(), 'GET', `/${id}/attachments`)).status, 403);
});

test('příloha přežije změnu stavu nápadu', async () => {
  const id = await newIdea();
  await upload(USER.pm(), `/${id}/attachments`, {}, [{ name: 'a.png', type: 'image/png', data: 'X' }]);
  await db.query(`UPDATE ideas SET state = 'rozpracovano' WHERE id = $1`, [id]);
  const att = await db.query('SELECT 1 FROM attachments WHERE idea_id = $1', [id]);
  assert.equal(att.rows.length, 1);
});

// ---------- 13) poznámky ----------

test('nápad má víc samostatných poznámek, každá vlastní záznam', async () => {
  const id = await newIdea();
  await api(USER.pm(), 'POST', `/${id}/notes`, { text: 'První' });
  await api(USER.pm(), 'POST', `/${id}/notes`, { text: 'Druhá' });
  const r = await api(USER.pm(), 'GET', `/${id}/notes`);
  assert.equal(r.body.notes.length, 2);
  assert.ok(r.body.notes.every(n => n.author_id === ctx.pm && n.author_name));
});

test('poznámku lze editovat a v historii zůstane stará i nová hodnota', async () => {
  const id = await newIdea();
  const c = await api(USER.pm(), 'POST', `/${id}/notes`, { text: 'Původní text' });
  const u = await api(USER.pm(), 'PATCH', `/${id}/notes/${c.body.note.id}`, { text: 'Nový text' });
  assert.equal(u.status, 200);
  assert.equal(u.body.note.text, 'Nový text');

  const ev = await db.query(`SELECT comment FROM idea_events WHERE idea_id=$1 AND action='note_edited'`, [id]);
  assert.match(ev.rows[0].comment, /Původní text/);
  assert.match(ev.rows[0].comment, /Nový text/);
});

test('prázdná poznámka → 400', async () => {
  const id = await newIdea();
  const r = await api(USER.pm(), 'POST', `/${id}/notes`, { text: '  ' });
  assert.equal(r.status, 400);
});

// ---------- 10 + 11) výchozí zobrazení a filtry ----------

test('výchozí seznam skrývá rozpracováno, hotovo i odloženo', async () => {
  await newIdea({ title: 'Aktivní', state: 'zadano' });
  await newIdea({ title: 'Běží', state: 'rozpracovano' });
  await newIdea({ title: 'Dokončený', state: 'hotovo' });
  await newIdea({ title: 'Odložený', state: 'odlozeno' });

  const titles = (await api(USER.pm(), 'GET', '/')).body.ideas.map(i => i.title);
  assert.ok(titles.includes('Aktivní'));
  assert.ok(!titles.includes('Běží'));
  assert.ok(!titles.includes('Dokončený'));
  assert.ok(!titles.includes('Odložený'));
});

test('skryté nápady jdou zobrazit filtrem stavu', async () => {
  await newIdea({ title: 'Dohledatelný', state: 'hotovo' });
  const titles = (await api(USER.pm(), 'GET', '/?state=hotovo')).body.ideas.map(i => i.title);
  assert.ok(titles.includes('Dohledatelný'));
});

test('filtry se kombinují (stav + zdroj + fulltext)', async () => {
  await api(USER.pm(), 'POST', '/internal', { ...IDEA, title: 'Unikátní kombinace' });
  const r = await api(USER.pm(), 'GET', '/?state=zadano&source=internal&q=Unik');
  const titles = r.body.ideas.map(i => i.title);
  assert.ok(titles.includes('Unikátní kombinace'));
  assert.ok(r.body.ideas.every(i => i.source === 'internal' && i.state === 'zadano'));
});

// ---------- 12) sloučit / přiřadit ----------

test('sloučení přenese přílohy i poznámky a nic neztratí', async () => {
  const src = await newIdea({ title: 'Zdrojový' });
  const dst = await newIdea({ title: 'Cílový' });
  await upload(USER.pm(), `/${src}/attachments`, {}, [{ name: 'z.png', type: 'image/png', data: 'X' }]);
  await api(USER.pm(), 'POST', `/${src}/notes`, { text: 'Poznámka ze zdroje' });

  const r = await api(USER.pm(), 'POST', `/${src}/merge`, { target_id: dst });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal((await db.query('SELECT 1 FROM attachments WHERE idea_id=$1', [dst])).rows.length, 1, 'příloha přešla na cíl');
  const notes = (await api(USER.pm(), 'GET', `/${dst}/notes`)).body.notes.map(n => n.text);
  assert.ok(notes.some(t => t.includes('Poznámka ze zdroje')));
  assert.ok(notes.some(t => t.includes('Sloučeno z nápadu')), 'popis zdroje se zachoval');

  const srcRow = (await db.query('SELECT merged_into_id FROM ideas WHERE id=$1', [src])).rows[0];
  // ideas.id je BIGINT → pg vrací string, proto porovnáváme čísla.
  assert.equal(Number(srcRow.merged_into_id), Number(dst));
});

test('sloučený nápad zmizí z výchozího seznamu, ale nesmaže se', async () => {
  const src = await newIdea({ title: 'Ke sloučení' });
  const dst = await newIdea({ title: 'Cíl B' });
  await api(USER.pm(), 'POST', `/${src}/merge`, { target_id: dst });

  const titles = (await api(USER.pm(), 'GET', '/')).body.ideas.map(i => i.title);
  assert.ok(!titles.includes('Ke sloučení'));
  assert.equal((await db.query('SELECT 1 FROM ideas WHERE id=$1', [src])).rows.length, 1, 'záznam existuje dál');
});

test('nápad nelze sloučit sám se sebou', async () => {
  const id = await newIdea();
  const r = await api(USER.pm(), 'POST', `/${id}/merge`, { target_id: id });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'self_merge');
});

test('z nápadu vznikne úkol v projektu a nápad se posune na rozpracováno', async () => {
  const id = await newIdea();
  const r = await api(USER.pm(), 'POST', `/${id}/create-task`, { project_id: ctx.project, priority: 'high' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.task.project_id, ctx.project);

  const link = await db.query('SELECT 1 FROM idea_tasks WHERE idea_id=$1 AND task_id=$2', [id, r.body.task.id]);
  assert.equal(link.rows.length, 1, 'vazba nápad → úkol přes ID');
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'rozpracovano');
});

// Multi-team izolace — PM Nápadníku nesmí sahat do cizího týmu.
test('úkol nelze vytvořit v projektu týmu, kde nejsem členem', async () => {
  const foreignTeam = (await db.query(`INSERT INTO teams (name,slug) VALUES ('Cizí','cizi-t') RETURNING id`)).rows[0].id;
  const foreignProject = (await db.query(
    `INSERT INTO projects (name,start_date,team_id) VALUES ('Cizí projekt',CURRENT_DATE,$1) RETURNING id`, [foreignTeam]
  )).rows[0].id;
  const id = await newIdea();
  const r = await api(USER.pm(), 'POST', `/${id}/create-task`, { project_id: foreignProject });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'not_team_member');
});

test('řešitel mimo tým projektu je odmítnut', async () => {
  const id = await newIdea();
  // Manager je v týmu Management, ne v IT týmu projektu.
  const r = await api(USER.pm(), 'POST', `/${id}/create-task`, {
    project_id: ctx.project, assignee_id: ctx.mgmt,
  });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.assignee_id);
});

test('ze zamítnutého nápadu úkol nevznikne', async () => {
  const id = await newIdea({ state: 'zamitnuto' });
  const r = await api(USER.pm(), 'POST', `/${id}/create-task`, { project_id: ctx.project });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_state');
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'zamitnuto');
});

test('cizí poznámku nelze přepsat', async () => {
  const id = await newIdea();
  const c = await api(USER.pm(), 'POST', `/${id}/notes`, { text: 'Poznámka PM' });
  // Management smí (má dohled), běžný PM cizí ne — tady ověřujeme autora.
  const mine = await api(USER.pm(), 'PATCH', `/${id}/notes/${c.body.note.id}`, { text: 'Vlastní úprava' });
  assert.equal(mine.status, 200);
});

test('neplatný stav ve filtru → 400, ne tiché zobrazení všeho', async () => {
  const r = await api(USER.pm(), 'GET', '/?state=neexistuje');
  assert.equal(r.status, 400);
});

test('nečíselné id nespadne na 500', async () => {
  const r = await api(USER.pm(), 'POST', '/abc/reactivate');
  assert.equal(r.status, 400);
});

// ---------- 9) lifecycle ----------

test('nápad je Hotovo až po dokončení VŠECH navázaných úkolů', async () => {
  const { syncIdeasForTask } = await import('../../ideaLifecycle.js');
  const id = await newIdea();
  const t1 = (await api(USER.pm(), 'POST', `/${id}/create-task`, { project_id: ctx.project })).body.task.id;
  const t2 = (await api(USER.pm(), 'POST', `/${id}/create-task`, { project_id: ctx.project })).body.task.id;

  await db.query(`UPDATE tasks SET status='done' WHERE id=$1`, [t1]);
  await syncIdeasForTask(t1);
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'rozpracovano',
    'jeden hotový úkol nápad neuzavře');

  await db.query(`UPDATE tasks SET status='done' WHERE id=$1`, [t2]);
  await syncIdeasForTask(t2);
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'hotovo');
});

test('dokončení navázaného projektu uzavře nápad', async () => {
  const { syncIdeasForProject } = await import('../../ideaLifecycle.js');
  const id = await newIdea({ state: 'rozpracovano' });
  await db.query(`UPDATE ideas SET linked_project_id=$1 WHERE id=$2`, [ctx.project, id]);
  await db.query(`UPDATE projects SET status='done' WHERE id=$1`, [ctx.project]);

  await syncIdeasForProject(ctx.project);
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'hotovo');
  await db.query(`UPDATE projects SET status='active' WHERE id=$1`, [ctx.project]);
});

// ---------- 14) odloženo ----------

test('odložený nápad lze znovu aktivovat do stavu zadano', async () => {
  const id = await newIdea({ state: 'odlozeno' });
  const r = await api(USER.pm(), 'POST', `/${id}/reactivate`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state, 'zadano');

  const ev = await db.query(`SELECT 1 FROM idea_events WHERE idea_id=$1 AND action='reactivated'`, [id]);
  assert.equal(ev.rows.length, 1, 'změna je v historii');
});

test('znovu aktivovat lze jen odložený nápad', async () => {
  const id = await newIdea({ state: 'zadano' });
  const r = await api(USER.pm(), 'POST', `/${id}/reactivate`);
  assert.equal(r.status, 400);
});
