// ContextAssembler testy – query a readFile jsou plně injektované,
// takže testy běží bez DB i bez filesystému.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextAssembler } from '../contextAssembler.js';

/**
 * Mini "DB" – odpovídá různé řádky podle prvních pár znaků SQL.
 */
function makeFakeQuery({ task, parent, project, comments }) {
  return async (sql, params) => {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('select * from tasks where id'))     return { rows: task ? [task] : [] };
    if (s.includes('from tasks where id = $1') && s.includes('priority')) {
      // Parent fetch
      return { rows: parent ? [parent] : [] };
    }
    if (s.includes('from projects where id'))             return { rows: project ? [project] : [] };
    if (s.includes('from questions q'))                   return { rows: comments || [] };
    throw new Error('unmocked sql: ' + s.slice(0, 100));
  };
}

test('assemble: throw pro neplatný taskId', async () => {
  const a = createContextAssembler({ query: async () => ({ rows: [] }), readFile: async () => '' });
  await assert.rejects(() => a.assemble(0), /kladné celé/);
  await assert.rejects(() => a.assemble(-1), /kladné celé/);
  await assert.rejects(() => a.assemble(1.5), /kladné celé/);
});

test('assemble: throw když task neexistuje', async () => {
  const a = createContextAssembler({
    query: makeFakeQuery({ task: null }),
    readFile: async () => '',
  });
  await assert.rejects(() => a.assemble(999), /neexistuje/);
});

test('assemble: minimální bundle bez parenta a bez CLAUDE.md', async () => {
  const task = {
    id: 5, project_id: null, parent_id: null,
    title: 'X', description: 'desc', priority: 'normal', status: 'todo',
    due_date: null, estimated_h: null,
    ai_assignee: true, execution_mode: 'manual', ai_status: 'queued',
    acceptance_criteria: ['ac1'], out_of_scope: [], scope_paths: [],
    iteration_count: 0, max_iterations: 3, ai_cost_usd: 0,
  };
  const a = createContextAssembler({
    query: makeFakeQuery({ task, comments: [] }),
    readFile: async () => { throw new Error('ENOENT'); },
  });
  const bundle = await a.assemble(5);
  assert.equal(bundle.task.id, 5);
  assert.equal(bundle.parent, null);
  assert.equal(bundle.project, null);
  assert.deepEqual(bundle.comments, []);
  assert.equal(bundle.claudeMd.source, 'missing');
  assert.equal(bundle.claudeMd.content, null);
  assert.ok(bundle.assembledAt);
});

test('assemble: s parentem, projektem, komentáři a CLAUDE.md', async () => {
  const task = {
    id: 10, project_id: 1, parent_id: 7,
    title: 'Child', description: 'd', priority: 'high', status: 'todo',
    due_date: null, estimated_h: 2,
    ai_assignee: true, execution_mode: 'auto', ai_status: 'queued',
    acceptance_criteria: ['ac'], out_of_scope: ['x'], scope_paths: ['client/src/'],
    iteration_count: 0, max_iterations: 3, ai_cost_usd: 0,
  };
  const parent = { id: 7, title: 'Parent', description: 'p', status: 'in_progress', priority: 'high', due_date: null };
  const project = { id: 1, name: 'Proj', description: 'P', status: 'active', due_date: null };
  const comments = [
    { id: 1, question: 'A?', answer: 'B', status: 'answered', from_user_name: 'X', to_user_name: 'Y', created_at: '2026-01-01' },
  ];
  const a = createContextAssembler({
    query: makeFakeQuery({ task, parent, project, comments }),
    readFile: async () => '# CLAUDE.md\nhello',
  });
  const bundle = await a.assemble(10);
  assert.equal(bundle.task.id, 10);
  assert.equal(bundle.parent?.id, 7);
  assert.equal(bundle.project?.name, 'Proj');
  assert.equal(bundle.comments.length, 1);
  assert.equal(bundle.claudeMd.source, 'file');
  assert.ok(bundle.claudeMd.content.includes('CLAUDE.md'));
});

test('assemble: shapeTaskForBundle pouští jen relevantní fieldy', async () => {
  const task = {
    id: 1, project_id: null, parent_id: null,
    title: 't', description: null, priority: 'low', status: 'todo',
    due_date: null, estimated_h: null,
    // tato pole nemají být v bundle.task:
    completed_at: '2026-01-01', completed_by: 99, actual_h: 4,
    // tato MUSÍ být:
    ai_assignee: false, execution_mode: 'manual', ai_status: 'idle',
    acceptance_criteria: [], out_of_scope: [], scope_paths: [],
    iteration_count: 0, max_iterations: 3, ai_cost_usd: 0,
  };
  const a = createContextAssembler({
    query: makeFakeQuery({ task, comments: [] }),
    readFile: async () => { throw new Error('ENOENT'); },
  });
  const bundle = await a.assemble(1);
  assert.equal('completed_at' in bundle.task, false);
  assert.equal('completed_by' in bundle.task, false);
  assert.equal('actual_h' in bundle.task, false);
  assert.equal('ai_status' in bundle.task, true);
  assert.equal('acceptance_criteria' in bundle.task, true);
});

test('assemble: výsledný bundle je zmrazený (Object.freeze)', async () => {
  const task = {
    id: 2, project_id: null, parent_id: null, title: 't', description: '',
    priority: 'normal', status: 'todo', due_date: null, estimated_h: null,
    ai_assignee: false, execution_mode: 'manual', ai_status: 'idle',
    acceptance_criteria: [], out_of_scope: [], scope_paths: [],
    iteration_count: 0, max_iterations: 3, ai_cost_usd: 0,
  };
  const a = createContextAssembler({
    query: makeFakeQuery({ task, comments: [] }),
    readFile: async () => { throw new Error('ENOENT'); },
  });
  const bundle = await a.assemble(2);
  assert.equal(Object.isFrozen(bundle), true);
});
