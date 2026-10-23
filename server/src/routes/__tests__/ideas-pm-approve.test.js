// Právo „PM Nápadníku smí schvalovat" (příznak idea_pms.can_approve_ideas).
//
// Smysl: Kateřina (PM Nápadníku) má schvalovat nápady, ale nemá být v týmu
// Management — to by jí dalo i práva mimo Nápadník. Test drží obě strany:
// bez příznaku neschválí, s příznakem schválí, a příznak nesmí odemknout
// nic mimo Nápadník.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { startTestDb } from '../../testing/testDb.js';

let db, stopDb, server, port, signToken, ctx;

const mk = async (e, n, r) =>
  (await db.query(`INSERT INTO users (email,name,role) VALUES ($1,$2,$3) RETURNING id`, [e, n, r])).rows[0].id;

async function seed() {
  const mgmtTeam = (await db.query(`
    INSERT INTO teams (name, slug) VALUES ('Management','management')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `)).rows[0].id;

  // PM Nápadníku, který NENÍ v Managementu — přesně Kateřinin případ.
  const pm = await mk('pm-approve@t.cz', 'PM', 'manager');
  await db.query(`INSERT INTO idea_pms (user_id) VALUES ($1)`, [pm]);

  // Člen Managementu pro kontrolní srovnání.
  const mgmt = await mk('mgmt-approve@t.cz', 'Mgmt', 'manager');
  await db.query(`INSERT INTO team_members (team_id,user_id,team_role) VALUES ($1,$2,'manager')`, [mgmtTeam, mgmt]);

  return { pm, mgmt };
}

const asUser = (id, email, name) => ({ id, email, role: 'manager', name });

const api = async (who, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/ideas${path}`, {
    method,
    headers: { cookie: `tf_token=${signToken(who)}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const PM = () => asUser(ctx.pm, 'pm-approve@t.cz', 'PM');
const MGMT = () => asUser(ctx.mgmt, 'mgmt-approve@t.cz', 'Mgmt');

const newIdea = async (state = 'ke_schvaleni') => (await db.query(`
  INSERT INTO ideas (proposer_name, proposer_email, title, department, category,
    problem_description, solution_proposal, state)
  VALUES ('N','n@t.cz','Nápad','Marketing','AI využití','problém','řešení',$1) RETURNING id
`, [state])).rows[0].id;

const stateOf = async (id) => (await db.query('SELECT state FROM ideas WHERE id=$1', [id])).rows[0].state;
const setApprove = (v) => db.query(`UPDATE idea_pms SET can_approve_ideas = $1 WHERE user_id = $2`, [v, ctx.pm]);

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

test('výchozí stav: PM Nápadníku bez příznaku neschvaluje', async () => {
  await setApprove(false);
  const id = await newIdea();

  const tr = await api(PM(), 'GET', `/${id}/transitions`);
  const approve = tr.body.transitions.find(t => t.to === 'schvaleno_ceka_na_analyzu');
  assert.equal(approve.allowed, false, 'tlačítko se nenabízí');
  assert.equal(tr.body.canApprove, false);

  const r = await api(PM(), 'POST', `/${id}/state`, { to_state: 'schvaleno_ceka_na_analyzu', comment: 'OK' });
  assert.equal(r.status, 403, 'a ani přes API to neprojde');
  assert.equal(await stateOf(id), 'ke_schvaleni');
});

test('s příznakem PM nápad schválí', async () => {
  await setApprove(true);
  const id = await newIdea();

  const tr = await api(PM(), 'GET', `/${id}/transitions`);
  assert.equal(tr.body.canApprove, true);
  assert.equal(tr.body.isManagement, false, 'právo nedělá z PM Management');
  assert.equal(tr.body.transitions.find(t => t.to === 'schvaleno_ceka_na_analyzu').allowed, true);

  const r = await api(PM(), 'POST', `/${id}/state`, { to_state: 'schvaleno_ceka_na_analyzu', comment: 'Schvaluju.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await stateOf(id), 'schvaleno_ceka_na_analyzu');
});

test('s příznakem PM smí i zamítnout, odložit a schválit analýzu', async () => {
  await setApprove(true);

  const rejected = await newIdea();
  assert.equal((await api(PM(), 'POST', `/${rejected}/state`, { to_state: 'zamitnuto', comment: 'Nedává smysl.' })).status, 200);
  assert.equal(await stateOf(rejected), 'zamitnuto');

  const postponed = await newIdea();
  assert.equal((await api(PM(), 'POST', `/${postponed}/state`, { to_state: 'odlozeno', comment: 'Až po Q1.' })).status, 200);

  const analysis = await newIdea('ke_schvaleni_analyzy');
  assert.equal((await api(PM(), 'POST', `/${analysis}/state`, { to_state: 'schvalena_analyza', comment: 'Analýza OK.' })).status, 200);
  assert.equal(await stateOf(analysis), 'schvalena_analyza');
});

test('příznak nedává práva Managementu mimo schvalování (report zůstává zavřený)', async () => {
  await setApprove(true);
  // Report/Dashboard jsou vázané na Management, ne na schvalování nápadů.
  const r = await api(PM(), 'GET', '/_meta/perms');
  assert.equal(r.body.is_management, false);
  assert.equal(r.body.can_approve_ideas, true);
});

test('Management schvaluje i bez příznaku', async () => {
  await setApprove(false);
  const id = await newIdea();
  const r = await api(MGMT(), 'POST', `/${id}/state`, { to_state: 'schvaleno_ceka_na_analyzu', comment: 'OK' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('odebrání role PM smaže i právo schvalovat', async () => {
  await setApprove(true);
  await db.query(`DELETE FROM idea_pms WHERE user_id = $1`, [ctx.pm]);
  const id = await newIdea();
  const r = await api(PM(), 'POST', `/${id}/state`, { to_state: 'schvaleno_ceka_na_analyzu', comment: 'OK' });
  assert.equal(r.status, 403, 'bez PM role nemá na Nápadník vůbec přístup');

  // Vrátíme zpět bez příznaku — právo se neobnoví samo.
  await db.query(`INSERT INTO idea_pms (user_id) VALUES ($1)`, [ctx.pm]);
  const tr = await api(PM(), 'GET', `/${id}/transitions`);
  assert.equal(tr.body.canApprove, false, 'právo se nevrací automaticky');
});
