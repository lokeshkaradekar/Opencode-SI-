// Frontend tests for the per-task activity record in agent.js (node >= 18): node --test tests/frontend/agent.test.js
// These cover the real-time activity indicator, click-to-expand state and multi-task history described in the
// SI activity spec. Every assertion is driven by the same mocked Bridge the other frontend tests use -- nothing
// here fabricates progress the real agent.js wouldn't have produced itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function setup(bridge) {
  const store = {}, sets = [];
  const listeners = {};
  const busL = {};
  const ctx = vm.createContext({
    console, Promise, JSON, setTimeout: (f) => setImmediate(f), clearTimeout,
    UI: { h: () => ({}), toast() {}, dot() {}, confirm: () => Promise.resolve(true), icon() {} },
    Bus: { emit(n, d) { (busL[n] || []).forEach((f) => f(d)); }, on(n, f) { (busL[n] = busL[n] || []).push(f); return () => {}; } },
    Persist: { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set(k, v) { sets.push(k); store[k] = JSON.stringify(v); }, del(k) { delete store[k]; } },
    State: { project: { id: 'p1', name: 'P' } },
    Redact: { text: (s) => s },
    Errors: { classify: (e, code) => ({ category: 'X', simple: String(e.message), code }) },
    Router: {}, Health: {}, Git: {}, Terminal: {},
    OpenCode: { status: { state: 'READY' }, ready: () => true },
    Bridge: Object.assign({ mode: 'native',
      on: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
      emit: (n, d) => (listeners[n] || []).forEach((f) => f(d)) }, bridge),
  });
  ctx.window = ctx;
  ctx.store = store; ctx.sets = sets;
  return ctx;
}
const load = (ctx, files) => files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) { for (let i = 0; i < 200 && !fn(); i++) await tick(); }

function activityRecords(ctx) { return ctx.Agent.history.filter((m) => m.role === 'activity'); }

test('activity record starts in "thinking" with zero steps, not an invented state', async () => {
  let resolveStatus = null;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolveStatus = r; }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('do something');
  await until(() => resolveStatus !== null);
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'thinking');
  assert.strictEqual(rec.steps.length, 0);
  assert.strictEqual(rec.expanded, false, 'collapsed by default');
  resolveStatus({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'done', error: null, snapshot: null });
  await p;
});

test('phase moves to "acting" only once a real step exists, labelled from the real tool+arg', async () => {
  let n = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve(++n === 1
      ? { state: 'RUNNING', steps: [{ tool: 'write_file', arg: 'TodoList.jsx', done: false, ok: false }], changes: [], summary: [] }
      : { state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'TodoList.jsx', done: true, ok: true }], changes: [{ path: 'TodoList.jsx' }], summary: ['Edited TodoList.jsx'], reply: 'done', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('update the todo list');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'done');
  assert.strictEqual(rec.steps[0].tool, 'write');
  assert.strictEqual(rec.steps[0].arg, 'TodoList.jsx');
  assert.strictEqual(rec.steps[0].state, 'done');
});

test('click-to-expand: expanded is per-record and independent of a second, later task', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'ok', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('first task');
  const first = activityRecords(ctx)[0];
  assert.strictEqual(first.expanded, false);
  first.expanded = true; // simulates the user's click (renderActivity toggles this same field on click)
  await ctx.Agent.sendMessage('second task');
  const [a, b] = activityRecords(ctx);
  assert.strictEqual(a.expanded, true, 'earlier task keeps the user\'s expand choice');
  assert.strictEqual(b.expanded, false, 'new task starts collapsed, independent of the first');
  assert.notStrictEqual(a, b, 'each task gets its own activity record, never shared');
});

test('multiple sequential tasks never mix steps: each activity record only has its own', async () => {
  let call = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => {
      call++;
      if (call === 1) return Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'read_file', arg: 'a.js', done: true, ok: true }], changes: [], summary: ['Read a.js'], reply: '1', error: null, snapshot: null });
      return Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'b.js', done: true, ok: true }], changes: [{ path: 'b.js' }], summary: ['Edited b.js'], reply: '2', error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('task one');
  await ctx.Agent.sendMessage('task two');
  const [a, b] = activityRecords(ctx);
  assert.strictEqual(a.steps.length, 1);
  assert.strictEqual(a.steps[0].arg, 'a.js');
  assert.strictEqual(b.steps.length, 1);
  assert.strictEqual(b.steps[0].arg, 'b.js', 'second record does not inherit the first task\'s step');
});

test('task completion sets phase "done" and the record is retained afterward for later inspection', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'run_command', arg: 'npm test', done: true, ok: true }], changes: [], summary: ['Ran tests'], reply: 'done', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('run the tests');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'done');
  // still present in history after completion -- nothing removes a finished activity record
  assert.ok(ctx.Agent.history.includes(rec));
});

test('task failure sets phase "failed" with the real error message, record is retained', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'FAILED', steps: [{ tool: 'run_command', arg: 'npm test', done: true, ok: false }], changes: [], summary: [], reply: '', error: { message: 'Tests failed: 2 failing', code: 'RUN_FAILED' } }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('run the tests');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'failed');
  assert.strictEqual(rec.error, 'Tests failed: 2 failing');
  assert.ok(ctx.Agent.history.includes(rec), 'failed record stays visible, not removed');
});

test('cancellation sets phase "cancelled", not "failed"', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'CANCELLED', steps: [], changes: [], summary: [], reply: '', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('cancel me');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'cancelled');
  assert.strictEqual(ctx.Agent.session.status, 'cancelled');
  assert.strictEqual(ctx.Agent.canResume, true, 'a cancelled task can be resumed, i.e. "waiting" is represented via canResume/banner, not faked as still working');
});

test('uncertain outcome (e.g. dropped connection) sets phase "uncertain", never silently "done"', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'UNCERTAIN', steps: [], changes: [], summary: [], reply: '', error: { code: 'OUTCOME_UNKNOWN', message: 'Connection dropped mid-task.' } }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('do work');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'uncertain');
  assert.notStrictEqual(rec.phase, 'done');
});

test('duplicate/unchanged poll ticks do not duplicate or lose steps', async () => {
  let n = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => {
      n++;
      const steps = [{ tool: 'read_file', arg: 'a.js', done: true, ok: true }];
      // Same in-flight snapshot reported twice in a row (a delayed/duplicate event from the server),
      // then the real terminal state.
      if (n <= 2) return Promise.resolve({ state: 'RUNNING', steps, changes: [], summary: [] });
      return Promise.resolve({ state: 'SUCCESS', steps, changes: [], summary: ['Read a.js'], reply: 'ok', error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('read the file');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.steps.length, 1, 'repeated identical poll ticks must not accumulate duplicate steps');
});

test('a stale/out-of-order status response is ignored once a newer task has started (runId guard)', async () => {
  let resolveStatus = null;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolveStatus = r; }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('start a task'); // real session set up by sendMessage, poll() in flight
  await until(() => resolveStatus !== null);
  const rec = activityRecords(ctx)[0];
  ctx.Agent.runId++; // a newer operation (project switch, cancel+restart) supersedes this run
  resolveStatus({ state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'late.js', done: true, ok: true }], changes: [{ path: 'late.js' }], summary: ['late'], reply: 'late reply', error: null, snapshot: null });
  await p.catch(() => {}); // the superseded run's promise still settles, just without effect
  assert.strictEqual(rec.phase, 'thinking', 'stale/superseded poll result must not mutate the old record');
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'late reply'), 'stale reply must not be appended');
});


test('stalled RUNNING task is cancelled and exits Thinking after the watchdog deadline', async () => {
  let resolveStatus = null;
  let cancelCalls = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentCancel: () => { cancelCalls++; return Promise.resolve({ cancelRequested: true }); },
    agentStatus: () => new Promise((r) => { resolveStatus = r; }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('please reply');
  await until(() => resolveStatus !== null);
  const rec = activityRecords(ctx)[0];
  rec.startedAt = Date.now() - (5 * 60 * 1000 + 1000);
  resolveStatus({ state: 'RUNNING', steps: [], changes: [], summary: [], reply: '', error: null, snapshot: null });
  await p;
  assert.strictEqual(cancelCalls, 1, 'watchdog requests server cancellation once');
  assert.strictEqual(ctx.Agent.status, 'error', 'UI leaves working state');
  assert.strictEqual(rec.phase, 'failed', 'activity no longer remains Thinking');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'error' && /5 minutes/.test(m.err.simple || m.err.message || '')), 'visible timeout error explains next diagnostic step');
});

test('missing/empty progress info never invents a step: steps stays empty, phase stays "thinking"', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'done with nothing to report', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('a trivial request');
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.steps.length, 0);
  assert.strictEqual(rec.phase, 'done');
});

test('activity history persists across multiple tasks in order, available for later inspection', async () => {
  let call = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => {
      call++;
      return Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'task ' + call, error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('one');
  await ctx.Agent.sendMessage('two');
  await ctx.Agent.sendMessage('three');
  assert.strictEqual(activityRecords(ctx).length, 3);
  const replies = ctx.Agent.history.filter((m) => m.role === 'agent').map((m) => String(m.text));
  assert.strictEqual(replies.join('|'), 'task 1|task 2|task 3');
});

test('agent aligns the OpenCode workspace with the selected project before sending a task', async () => {
  const order = [];
  const ctx = setup({
    opencodeSetWorkspace: (mode) => { order.push('workspace:' + mode); return Promise.resolve({ mode }); },
    agentStart: () => { order.push('session'); return Promise.resolve({ sessionId: 'workspace-session' }); },
    agentSend: () => { order.push('send'); return Promise.resolve({}); },
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'done', error: null }),
  });
  ctx.OpenCode.ensure = () => { order.push('ensure'); return Promise.resolve({ state: 'READY', managed: true, workspaceVerified: true }); };
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('create a file');
  assert.deepStrictEqual(order.slice(0, 4), ['workspace:project', 'ensure', 'session', 'send']);
});

test('agent refuses to send if selected-project workspace cannot be verified', async () => {
  let sends = 0;
  const ctx = setup({
    opencodeSetWorkspace: () => Promise.resolve({ mode: 'project' }),
    agentStart: () => Promise.resolve({ sessionId: 'must-not-send' }),
    agentSend: () => { sends++; return Promise.resolve({}); },
  });
  ctx.OpenCode.ensure = () => Promise.resolve({ state: 'READY', managed: false, workspaceVerified: false });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('create a file');
  assert.strictEqual(sends, 0, 'never send a task into an unverified workspace');
  assert.strictEqual(ctx.Agent.session, null, 'do not create a session before workspace validation');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'error' && /could not verify/i.test(m.err.simple)));
});

test('deleting a project clears its cached session so recreating the same name starts fresh', () => {
  const ctx = setup({});
  load(ctx, ['app/js/agent.js']);
  ['session:p1', 'tasks:p1', 'mode:p1', 'history:p1', 'pending:p1', 'tabs:p1'].forEach((k) => {
    ctx.Persist.set(k, k === 'session:p1' ? { id: 'old-session', projectId: 'p1', status: 'idle' } : ['stale']);
  });
  ctx.Agent.key = 'p1';
  ctx.Agent.session = { id: 'old-session', projectId: 'p1', status: 'idle' };
  ctx.Agent.history = [{ role: 'user', text: 'old conversation' }];
  ctx.Agent.resetProjectData('p1');
  assert.strictEqual(ctx.Agent.session, null);
  assert.strictEqual(ctx.Agent.history.length, 0);
  ['session:p1', 'tasks:p1', 'mode:p1', 'history:p1', 'pending:p1', 'tabs:p1'].forEach((k) => {
    assert.strictEqual(k in ctx.store, false, k + ' should be removed');
  });
  assert.strictEqual(ctx.Agent.status, 'idle');
});

test('restartChat clears the current transcript and session reference but preserves task archive and project files', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'fresh-session' }),
    agentHistory: () => Promise.resolve([]),
    opencodeSetWorkspace: () => Promise.resolve({}),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'fresh', error: null, snapshot: null }),
  });
  ctx.store['session:p1'] = JSON.stringify({ id: 'old-session', projectId: 'p1', task: 'old task', status: 'done' });
  ctx.store['tasks:p1'] = JSON.stringify([{ id: 'old-session', task: 'old task' }]);
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.history = [{ role: 'user', text: 'old chat' }];
  await ctx.Agent.restartChat();
  assert.strictEqual(ctx.Agent.session, null);
  assert.deepStrictEqual(ctx.Agent.history, []);
  assert.ok(!('session:p1' in ctx.store), 'old active session reference removed');
  assert.ok(!('history:p1' in ctx.store), 'legacy local transcript removed');
  assert.ok('tasks:p1' in ctx.store, 'task archive preserved');
  await ctx.Agent.sendMessage('start fresh');
  assert.strictEqual(ctx.Agent.session.id, 'fresh-session');
  assert.strictEqual(ctx.Agent.session.task, 'start fresh');
});

test('restartChat refuses while a task is active', async () => {
  const ctx = setup({});
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.status = 'working';
  await assert.rejects(ctx.Agent.restartChat(), (e) => e && e.code === 'TASK_RUNNING');
});

test('reopening a running session shows a live Thinking/Working activity row', async () => {
  let statusCalls = 0;
  const ctx = setup({
    agentHistory: () => Promise.resolve([{ role: 'user', text: 'continue my task' }]),
    agentStatus: () => Promise.resolve(++statusCalls === 1
      ? { state: 'RUNNING', steps: [], changes: [], summary: [] }
      : { state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'finished', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.openSession('s1');
  const records = ctx.Agent.history.filter((m) => m.role === 'activity');
  assert.strictEqual(records.length, 1, 'a reopened live session gets a visible activity record');
  assert.strictEqual(records[0].phase, 'done', 'the record updates to the real terminal state');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'finished'));
});


test('working state always has one visible live activity record across repeated chat redraws', () => {
  const ctx = setup({});
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.status = 'working';
  // Simulate later chats where a status/header redraw happened but the live row append was lost.
  ctx.Agent.history.push({ role: 'user', text: 'third chat', ts: Date.now() });
  const first = ctx.Agent.ensureActiveActivity();
  assert.strictEqual(first.role, 'activity');
  assert.strictEqual(first.phase, 'thinking');
  assert.strictEqual(ctx.Agent.history[ctx.Agent.history.length - 1], first, 'live row is visible at the end of chat');
  assert.strictEqual(ctx.Agent.ensureActiveActivity(), first, 'subsequent redraws reuse the same row');
  assert.strictEqual(activityRecords(ctx).length, 1, 'redraw does not duplicate Thinking cards');
});

test('working activity record is moved back to the visible end if later rows bury it', () => {
  const ctx = setup({});
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.status = 'working';
  const rec = ctx.Agent.ensureActiveActivity();
  ctx.Agent.history.push({ role: 'system', text: 'interleaved status', ts: Date.now() });
  ctx.Agent.ensureActiveActivity();
  assert.strictEqual(ctx.Agent.history[ctx.Agent.history.length - 1], rec);
  assert.strictEqual(activityRecords(ctx).length, 1);
});
