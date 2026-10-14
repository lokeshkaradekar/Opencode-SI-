// Regression suite for the "Thinking indicator stops after a couple of chats" bug.
// Root cause: the native "opencode.task" completion event is keyed only by sessionId (every
// message in a chat reuses the same session id), and Android does not guarantee prompt,
// exactly-once delivery of that event. A delayed/duplicate event from an already-finished task
// could arrive while the NEXT task's own poll loop was genuinely still running, and the old
// handler unconditionally called Agent.poll(rec) again -- which bumps runId and starts a second,
// competing poll loop, silently orphaning the real in-flight one. Once orphaned, Agent.status
// stays 'working' forever with nothing left to resolve it: the header says "working" but the
// Thinking/activity card never updates again.
//
// Fix: Agent.poll() now takes a taskId. A second poll() call for the SAME taskId while that
// task's loop is still the live one (same runId) is treated as a wake-up nudge for the existing
// loop, never a reason to start a new one. Run: node --test app/js/agent.regression.test.js
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
    console, Promise, JSON, setTimeout: (f, ms) => setImmediate(f), clearTimeout,
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
  ctx.store = store; ctx.sets = sets; ctx._listeners = listeners;
  return ctx;
}
const load = (ctx, files) => files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, max) { for (let i = 0; i < (max || 500) && !fn(); i++) await tick(); if (!fn()) throw new Error('until() timed out'); }
function activityRecords(ctx) { return ctx.Agent.history.filter((m) => m.role === 'activity'); }
function fireNativeTask(ctx, sessionId, state) {
  (ctx._listeners['opencode.task'] || []).forEach((f) => f({ sessionId, state }));
}

test('ten consecutive tasks each show Thinking, with a stale native completion event racing every single one', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  let prevStaleEvent = null;
  for (let n = 1; n <= 10; n++) {
    const before = resolvers.length;
    const p = ctx.Agent.sendMessage('task ' + n);
    await until(() => resolvers.length === before + 1);

    // Task n must be showing Thinking right now.
    const recs = activityRecords(ctx);
    const rec = recs[recs.length - 1];
    assert.strictEqual(ctx.Agent.status, 'working', 'task ' + n + ': status must be working');
    assert.strictEqual(rec.phase, 'thinking', 'task ' + n + ': must show Thinking');

    // Fire a DELAYED native completion event from the PREVIOUS task (simulates Android's
    // non-guaranteed event delivery lagging behind by one full task).
    if (prevStaleEvent) fireNativeTask(ctx, prevStaleEvent.sessionId, prevStaleEvent.state);
    await tick();

    // Task n's Thinking indicator must survive the stale event from task n-1.
    const liveAfter = ctx.Agent.activeActivity;
    assert.strictEqual(ctx.Agent.status, 'working', 'task ' + n + ': still working after stale event');
    assert.ok(liveAfter, 'task ' + n + ': live activity record must still exist after stale event');
    assert.strictEqual(liveAfter.phase, 'thinking', 'task ' + n + ': Thinking must survive the stale event');

    // Now resolve task n for real.
    const idx = resolvers.length - 1;
    resolvers[idx]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'reply ' + n, error: null, snapshot: null });
    await p.catch(() => {});
    await until(() => ctx.Agent.status !== 'working');
    assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'reply ' + n), 'task ' + n + ': real reply must land');

    prevStaleEvent = { sessionId: 's1', state: 'SUCCESS' };
  }

  assert.strictEqual(activityRecords(ctx).length, 10, 'exactly ten activity records, one per task');
  assert.ok(activityRecords(ctx).every((r) => r.phase === 'done'), 'every task settled to done');
});

test('tool activity updates the correct (current) card, never a stale one, across many tasks', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  for (let n = 1; n <= 4; n++) {
    const before = resolvers.length;
    const p = ctx.Agent.sendMessage('task ' + n);
    await until(() => resolvers.length === before + 1);
    resolvers[before]({ state: 'RUNNING', steps: [{ tool: 'write_file', arg: 'file' + n + '.js', done: false }] });
    await until(() => resolvers.length === before + 2);
    const recs = activityRecords(ctx);
    assert.strictEqual(recs[recs.length - 1].phase, 'acting');
    assert.strictEqual(recs[recs.length - 1].steps[0].arg, 'file' + n + '.js', 'tool activity must land on THIS task\'s card');
    resolvers[before + 1]({ state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'file' + n + '.js', done: true, ok: true }], changes: [{ path: 'file' + n + '.js' }], summary: ['wrote file' + n + '.js'], reply: 'done ' + n, error: null, snapshot: null });
    await p.catch(() => {});
    await until(() => ctx.Agent.status !== 'working');
  }
  const recs = activityRecords(ctx);
  assert.strictEqual(recs.length, 4);
  recs.forEach((r, i) => assert.strictEqual(r.steps[0].arg, 'file' + (i + 1) + '.js', 'no cross-task step bleed'));
});

test('a new task starts polling after the previous task completes (no leftover "polling active" flag)', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  const p1 = ctx.Agent.sendMessage('first');
  await until(() => resolvers.length === 1);
  resolvers[0]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r1', error: null, snapshot: null });
  await p1;
  assert.strictEqual(ctx.Agent.status, 'idle');
  assert.strictEqual(ctx.Agent.pollingTaskId === null || ctx.Agent.activePollPromise === null, true);

  const p2 = ctx.Agent.sendMessage('second');
  await until(() => resolvers.length === 2);
  assert.strictEqual(ctx.Agent.status, 'working', 'second task must start a fresh poll loop');
  resolvers[1]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r2', error: null, snapshot: null });
  await p2;
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'r2'));
});

test('switching sessions (openSession) does not leave stale activity state from the old one', async () => {
  let taskResolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentHistory: () => Promise.resolve([]),
    // openSession('s2') does its own one-shot agentStatus(id, 0) check (idle, not running) which
    // must resolve independently of the old task's still-pending poll calls.
    agentStatus: (id) => id === 's2'
      ? Promise.resolve({ state: 'DONE', steps: [], changes: [], summary: [] })
      : new Promise((r) => { taskResolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  const p1 = ctx.Agent.sendMessage('running task');
  await until(() => taskResolvers.length === 1);
  assert.strictEqual(ctx.Agent.status, 'working');

  // Switch away to a different (idle) session mid-task.
  await ctx.Agent.openSession('s2');
  assert.strictEqual(ctx.Agent.status, 'idle', 'opening another session abandons the old live poll state');
  assert.strictEqual(activityRecords(ctx).length, 0, 'the new session starts with no inherited activity cards');

  // The old task's late response must not resurrect anything. Settle it (as the real Bridge
  // eventually would) so the abandoned promise chain doesn't leak into later tests/processes.
  taskResolvers[0]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'late', error: null, snapshot: null });
  await p1.catch(() => {}); // the superseded sendMessage() promise still settles once its poll loop sees it's stale
  assert.strictEqual(ctx.Agent.status, 'idle');
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'late'), 'stale session\'s late reply must not leak into the new session');
});

test('Restart Chat does not break the next task\'s polling', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's' + (resolvers.length < 1 ? '1' : '2') }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  const p1 = ctx.Agent.sendMessage('before restart');
  await until(() => resolvers.length === 1);
  resolvers[0]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r1', error: null, snapshot: null });
  await p1;

  await ctx.Agent.restartChat();
  assert.strictEqual(ctx.Agent.history.length, 0);

  const p2 = ctx.Agent.sendMessage('after restart');
  await until(() => resolvers.length === 2);
  const rec = activityRecords(ctx)[0];
  assert.strictEqual(rec.phase, 'thinking', 'first task after Restart Chat must show Thinking');
  resolvers[1]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r2', error: null, snapshot: null });
  await p2;
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'r2'));
});

test('a failed poll (transient status-read errors) recovers and still shows Thinking', async () => {
  let calls = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => {
      calls++;
      if (calls <= 3) return Promise.reject(new Error('transient'));
      return Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'recovered', error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('flaky task');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'recovered'), 'recovers after transient failures');
  assert.strictEqual(ctx.Agent.status, 'idle');
});

test('a late event from an OLD task cannot modify the NEW task\'s record', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');

  const p1 = ctx.Agent.sendMessage('old task');
  await until(() => resolvers.length === 1);
  const oldRec = activityRecords(ctx)[0];
  // Realistically supersede the old task the way restartChat()/resetProjectData() do: bump runId
  // AND bring status back to idle so the next sendMessage() is actually accepted.
  ctx.Agent.runId++;
  ctx.Agent.status = 'idle';
  resolvers[0]({ state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'old.js', done: true, ok: true }], changes: [], summary: ['old'], reply: 'old reply', error: null, snapshot: null });
  await p1.catch(() => {});

  const p2 = ctx.Agent.sendMessage('new task');
  await until(() => resolvers.length === 2);
  const newRec = activityRecords(ctx)[activityRecords(ctx).length - 1];
  assert.notStrictEqual(oldRec, newRec);
  assert.strictEqual(newRec.phase, 'thinking');
  resolvers[1]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'new reply', error: null, snapshot: null });
  await p2;
  assert.strictEqual(oldRec.steps.length, 0, 'the old record was never mutated by its own late response after being superseded');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'new reply'));
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'old reply'), 'the stale reply never lands');
});

test('reopening an active session restores its activity indicator and is not disrupted by a stale native event', async () => {
  let statusCalls = 0;
  const ctx = setup({
    agentHistory: () => Promise.resolve([{ role: 'user', text: 'continue' }]),
    agentStatus: () => {
      statusCalls++;
      return Promise.resolve(statusCalls === 1
        ? { state: 'RUNNING', steps: [], changes: [], summary: [] }
        : { state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'finished', error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.openSession('s1');
  const records = activityRecords(ctx);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].phase, 'done');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'finished'));
});

test('multiple tasks never create duplicate active cards even when nudged repeatedly', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('one task');
  await until(() => resolvers.length === 1);
  // Fire several redundant nudges in a row (duplicate native events).
  fireNativeTask(ctx, 's1', 'SUCCESS');
  fireNativeTask(ctx, 's1', 'SUCCESS');
  fireNativeTask(ctx, 's1', 'SUCCESS');
  await tick();
  assert.strictEqual(activityRecords(ctx).length, 1, 'no duplicate activity cards from repeated nudges');
  resolvers[0]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r', error: null, snapshot: null });
  await p.catch(() => {});
  await until(() => ctx.Agent.status !== 'working');
  assert.strictEqual(activityRecords(ctx).length, 1);
});

test('header status and activity card remain consistent across a long run of nudged tasks', async () => {
  let resolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 's1' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { resolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  for (let n = 1; n <= 6; n++) {
    const before = resolvers.length;
    const p = ctx.Agent.sendMessage('t' + n);
    await until(() => resolvers.length === before + 1);
    fireNativeTask(ctx, 's1', 'SUCCESS'); // redundant/duplicate nudge every time
    await tick();
    const working = ctx.Agent.status === 'working';
    const hasLiveCard = ctx.Agent.history.some((m) => m.role === 'activity' && (m.phase === 'thinking' || m.phase === 'acting'));
    assert.strictEqual(working, hasLiveCard, 't' + n + ': header "working" must match a live card being present');
    resolvers[before]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r' + n, error: null, snapshot: null });
    await p.catch(() => {});
    await until(() => ctx.Agent.status !== 'working');
  }
});
