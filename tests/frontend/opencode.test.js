// Frontend tests for the OpenCode integration (node >= 18):  node --test tests/frontend
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function setup(bridge) {
  const store = {}, sets = [], ctxIntervals = [];
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
const plain = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) { for (let i = 0; i < 200 && !fn(); i++) await tick(); }

test('no direct-provider path: agent.js has no Gateway, the bridge no longer calls the daemon agent', () => {
  assert.ok(!/Gateway/.test(read('app/js/agent.js')));
  const java = read('app/java/NativeBridge.java');
  assert.ok(!/\/v1\/agent\/(send|start|status|resume|cancel)/.test(java), 'chat must not use the daemon agent gateway');
  assert.ok(/oc\.agent\.send\(/.test(java) && /oc\.agent\.status\(/.test(java));
  assert.ok(!/opencode\.ai\/zen/.test(read('app/java/OpenCodeClient.java')), 'the model-list endpoint is not the agent API');
  assert.ok(!/0\.0\.0\.0/.test(read('app/java/OpenCodeServer.java')), 'server is never bound beyond loopback');
});

test('SUCCESS: the reply and steps come from the bridge status, session id is reused for the next message', async () => {
  const calls = [];
  let n = 0;
  const ctx = setup({
    agentStart: () => { calls.push('start'); return Promise.resolve({ sessionId: 'ses_1' }); },
    agentSend: (sid, msg, mode) => { calls.push(['send', sid, msg, mode]); return Promise.resolve({ accepted: true }); },
    agentStatus: () => Promise.resolve(++n % 2 ? { state: 'RUNNING', steps: [{ tool: 'bash', name: 'bash', arg: 'npm test', done: false, ok: false }], changes: [], summary: [] }
      : { state: 'SUCCESS', steps: [{ tool: 'write', arg: 'a.js', done: true, ok: true }], changes: [{ path: 'a.js' }], summary: ['Edited a.js'], reply: 'Fixed it.', error: null, snapshot: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('fix the bug');
  assert.strictEqual(ctx.Agent.status, 'idle');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'Fixed it.'));
  assert.deepStrictEqual(plain(calls[1]), ['send', 'ses_1', 'fix the bug', 'build']);
  n = 0;
  await ctx.Agent.sendMessage('next');
  assert.strictEqual(calls.filter((c) => c === 'start').length, 1, 'same session continued');
  assert.strictEqual(ctx.sets.filter((k) => /history/.test(k)).length, 0, 'transcript is never written to local storage');
});

test('UNCERTAIN outcome is shown as uncertain (never as success) and can be continued', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_2' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'UNCERTAIN', steps: [], changes: [], summary: [], reply: '', error: { code: 'OUTCOME_UNKNOWN', message: 'The connection broke; the task may not have finished.' } }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('do work');
  assert.strictEqual(ctx.Agent.session.status, 'uncertain');
  assert.strictEqual(ctx.Agent.canResume, true);
  assert.ok(ctx.Agent.history.some((m) => m.role === 'system' && /may not have finished/.test(m.text)));
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'agent'));
});

test('provider/agent failure surfaces the real message', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_3' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'FAILED', steps: [], changes: [], summary: [], reply: '', error: { code: 'PROVIDER_ERROR', message: 'Rate limit reached for this free model', details: 'APIError' } }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('x');
  assert.strictEqual(ctx.Agent.status, 'error');
  const e = ctx.Agent.history.filter((m) => m.role === 'error')[0];
  assert.ok(e && /Rate limit reached/.test(e.err.technical || e.err.simple));
});

test('SESSION_NOT_FOUND starts a fresh session and sends exactly once more', async () => {
  const sends = []; let starts = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_' + (++starts) }),
    agentSend: (sid) => { sends.push(sid); if (sid === 'ses_1') { const e = new Error('gone'); e.code = 'SESSION_NOT_FOUND'; return Promise.reject(e); } return Promise.resolve({}); },
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'ok', error: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('hello');
  assert.deepStrictEqual(plain(sends), ['ses_1', 'ses_2']);
});

test('Plan/Build: the mode is per project, persisted, and sent with the message', async () => {
  const modes = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_m' }), agentSend: (sid, msg, mode) => { modes.push(mode); return Promise.resolve({}); },
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'ok', error: null }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  assert.strictEqual(ctx.Agent.mode, 'build', 'defaults to Build');
  ctx.Agent.mode = 'plan';
  assert.strictEqual(ctx.Agent.mode, 'plan');
  assert.ok(ctx.sets.indexOf('mode:p1') >= 0, 'the per-project mode is persisted');
  await ctx.Agent.sendMessage('plan it first');
  assert.deepStrictEqual(modes, ['plan'], 'the mode goes with the request');
  ctx.Agent.load('p2');
  assert.strictEqual(ctx.Agent.mode, 'build', 'another project is unaffected');
  ctx.Agent.mode = 'nonsense';
  assert.strictEqual(ctx.Agent.mode, 'build', 'only Build/Plan are accepted');
});

test('AGENT_UNAVAILABLE (no Plan agent on the server): falls back to Build quietly, no generic error card', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_p' }),
    agentSend: () => { const e = new Error('This OpenCode server does not list a "plan" agent. Switch back to Build.'); e.code = 'AGENT_UNAVAILABLE'; return Promise.reject(e); },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.mode = 'plan';
  await ctx.Agent.sendMessage('plan it');
  assert.strictEqual(ctx.Agent.planUnavailable, true, 'the server\u2019s real rejection is recorded');
  assert.strictEqual(ctx.Agent.mode, 'build', 'falls back to Build');
  assert.strictEqual(ctx.Agent.status, 'idle', 'not left in the error state for an expected, already-explained limitation');
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'error'), 'no generic error card: the mode control\u2019s own note explains this');
  assert.ok(!ctx.Agent.history.some((m) => m.role === 'activity'), 'no dangling activity card for a task that never started');
  assert.strictEqual(ctx.Agent.canResume, false, 'a capability mismatch is not an interrupted task to resume');
});

test('task history: metadata only (never the transcript), newest first, and can be reopened', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_h' }),
    agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'write', arg: 'a.js', done: true, ok: true }], changes: [{ path: 'a.js' }], summary: ['Edited a.js'], reply: 'SECRET-REPLY', error: null, snapshot: 'snap1' }),
    agentHistory: () => Promise.resolve([{ role: 'user', text: 'the task' }, { role: 'agent', text: 'SECRET-REPLY' }]),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('the task');
  const list = ctx.Agent.taskHistory();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'ses_h');
  assert.strictEqual(list[0].state, 'SUCCESS');
  assert.strictEqual(list[0].snapshot, 'snap1');
  assert.strictEqual(list[0].changes, 1);
  assert.ok(ctx.store['tasks:p1'].indexOf('SECRET-REPLY') < 0, 'the conversation reply is never stored locally');
  await ctx.Agent.openSession('ses_h');
  assert.ok(ctx.Agent.history.some((m) => m.text === 'the task'), 'transcript restored from OpenCode');
  assert.ok(ctx.Agent.history.some((m) => m.text === 'SECRET-REPLY'));
  assert.strictEqual(ctx.Agent.session.status, 'done');
});

test('the same-session opencode.task event reconciles immediately without starting a second, competing poll loop; other sessions are ignored', async () => {
  // Regression test for the "Thinking indicator stops after a couple of chats" bug: the event is
  // keyed only by sessionId, and every message in a chat reuses the same session id, so a same-
  // session event does not mean "this exact task" -- it can be a delayed/duplicate signal from an
  // already-finished task arriving while a later task is genuinely still running. The event must
  // wake the existing poll loop (so the server is read back sooner than the next tick), but it
  // must NEVER bump runId/start a second loop: doing so orphans whichever request is actually in
  // flight, and once orphaned the UI is stuck saying "working" forever with no live poll left to
  // resolve it.
  let statusCalls = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_e' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => { statusCalls++; return Promise.resolve({ state: 'RUNNING', steps: [], changes: [], summary: [], reply: '', error: null }); },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.sendMessage('long job');
  await tick();
  assert.strictEqual(ctx.Agent.status, 'working');
  const run = ctx.Agent.runId;
  const callsBefore = statusCalls;
  ctx.Bridge.emit('opencode.task', { sessionId: 'other', state: 'SUCCESS' });
  assert.strictEqual(ctx.Agent.runId, run, 'a different session is ignored');
  ctx.Bridge.emit('opencode.task', { sessionId: 'ses_e', state: 'SUCCESS' });
  assert.strictEqual(ctx.Agent.runId, run, 'the current task\u2019s own live poll loop is kept, not superseded, by its own completion signal');
  await tick();
  assert.ok(statusCalls > callsBefore, 'the event still causes the server to be read back sooner than waiting for the next 1.5s tick');
  ctx.Agent.runId++;                                   // stop the poll the test started
  ctx.Agent.status = 'idle';
  await tick();
});

test('a stale opencode.task event from an OLDER, already-finished task cannot orphan the poll loop of the task that replaced it', async () => {
  let statusResolvers = [];
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_e' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => new Promise((r) => { statusResolvers.push(r); }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  ctx.Agent.sendMessage('first job');
  await tick();
  statusResolvers[0]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r1', error: null, snapshot: null });
  await tick(); await tick();
  assert.strictEqual(ctx.Agent.status, 'idle');

  ctx.Agent.sendMessage('second job');
  await tick();
  assert.strictEqual(ctx.Agent.status, 'working');
  const runDuringSecondJob = ctx.Agent.runId;

  // The first job's native completion event finally arrives late, after the second job has
  // already started and is still genuinely running under the same sessionId.
  ctx.Bridge.emit('opencode.task', { sessionId: 'ses_e', state: 'SUCCESS' });
  await tick();

  assert.strictEqual(ctx.Agent.runId, runDuringSecondJob, 'the stale event must not supersede the second job\u2019s own live poll loop');
  assert.strictEqual(ctx.Agent.status, 'working', 'the second job must still be marked working');

  // Resolve the second job's real, still-live poll for real.
  statusResolvers[1]({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'r2', error: null, snapshot: null });
  await tick(); await tick();
  assert.strictEqual(ctx.Agent.status, 'idle');
  assert.ok(ctx.Agent.history.some((m) => m.role === 'agent' && m.text === 'r2'), 'the second job\u2019s real reply must land, not be silently dropped');
});

test('transient status failures are tolerated; the task is not declared failed', async () => {
  let n = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_4' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => (++n <= 3 ? Promise.reject(new Error('bridge hiccup')) : Promise.resolve({ state: 'SUCCESS', steps: [], changes: [], summary: [], reply: 'done', error: null })),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('x');
  assert.strictEqual(ctx.Agent.status, 'idle');
  assert.ok(ctx.Agent.history.some((m) => m.text === 'done'));
});

test('app restarted mid-task: a persisted running session is reconciled with the server, not assumed', async () => {
  const ctx = setup({
    agentHistory: () => Promise.resolve([{ role: 'user', text: 'earlier' }, { role: 'agent', text: 'reply' }]),
    agentStatus: () => Promise.resolve({ state: 'UNCERTAIN', steps: [], changes: [], summary: [], reply: '', error: { code: 'OUTCOME_UNKNOWN', message: 'unknown outcome' } }),
  });
  ctx.store['agent-dummy'] = '1';
  ctx.Persist.set('session:p1', { id: 'ses_9', projectId: 'p1', task: 'big job', steps: [], stepsDone: 0, status: 'running', modified: [] });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await until(() => ctx.Agent.session.status === 'uncertain');
  assert.strictEqual(ctx.Agent.session.status, 'uncertain');
  assert.ok(ctx.Agent.history.some((m) => m.text === 'earlier'), 'transcript restored from OpenCode');
});

test('OpenCode state model: labels/tones, single start, events update the indicator', async () => {
  let ensures = 0;
  const ctx = setup({
    opencodeStatus: () => Promise.resolve({ state: 'CHECKING_SERVER', message: 'x' }),
    opencodeEnsure: () => { ensures++; return Promise.resolve({ state: 'READY', message: 'ok' }); },
    opencodeModels: () => Promise.resolve({ models: [], selected: 'auto' }),
  });
  load(ctx, ['app/js/opencode.js']);
  const O = ctx.OpenCode;
  const want = { READY: ['Ready', 'ok'], STARTING_SERVER: ['Starting OpenCode', 'warning'], WAITING_FOR_HEALTH: ['Starting OpenCode', 'warning'], RESTARTING: ['Reconnecting', 'warning'],
    SERVER_STOPPED: ['Connection lost', 'failed'], NOT_CONFIGURED: ['Setup required', 'failed'], AUTHENTICATION_FAILED: ['Authentication required', 'failed'], CONNECTION_FAILED: ['Startup failed', 'failed'] };
  Object.keys(want).forEach((s) => { O.set({ state: s }); assert.deepStrictEqual([O.label(), O.tone()], want[s], s); });
  await Promise.all([O.start(), O.start(), O.start()]);
  assert.strictEqual(ensures, 1, 'the UI asks the native side to start only once');
  ctx.Bridge.emit('opencode.state', { state: 'RESTARTING', message: 'r' });
  assert.strictEqual(O.label(), 'Reconnecting');
});

test('OpenCode errors are classified into actionable categories', () => {
  const ctx = setup({});
  load(ctx, ['app/js/errors.js']);
  const E = ctx.Errors;
  assert.strictEqual(E.classify({ message: 'x' }, 'TERMUX_MISSING').category, 'SETUP');
  assert.strictEqual(E.classify({ message: 'x' }, 'PERMISSION_MISSING').category, 'SETUP');
  assert.strictEqual(E.classify({ message: 'x' }, 'PORT_CONFLICT').category, 'SERVER');
  assert.strictEqual(E.classify({ message: 'x' }, 'STARTUP_TIMEOUT').category, 'SERVER');
  assert.strictEqual(E.classify({ message: 'x' }, 'OUTCOME_UNKNOWN').category, 'SERVER');
  assert.strictEqual(E.classify({ message: 'x' }, 'PROVIDER_AUTH').category, 'AUTH');
});

test('activity record: phase moves thinking -> acting -> done, driven only by real steps/state', async () => {
  let n = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_a' }), agentSend: () => Promise.resolve({ accepted: true }),
    agentStatus: () => {
      n++;
      if (n === 1) return Promise.resolve({ state: 'RUNNING', steps: [], changes: [], summary: [] });
      if (n === 2) return Promise.resolve({ state: 'RUNNING', steps: [{ tool: 'write_file', arg: 'a.js', done: false, ok: false }], changes: [], summary: [] });
      return Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'write_file', arg: 'a.js', done: true, ok: true }], changes: [{ path: 'a.js' }], summary: ['Edited a.js'], reply: 'Done.', error: null, snapshot: 'snap1' });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('fix it');
  await tick();
  const rec = ctx.Agent.history.find((m) => m.role === 'activity');
  assert.ok(rec, 'an activity record is created when the message is sent');
  assert.strictEqual(rec.phase, 'thinking', 'no steps yet: phase is thinking, not a fabricated state');
  await until(() => rec.phase === 'acting');
  assert.strictEqual(rec.steps[0].tool, 'write');
  assert.strictEqual(rec.steps[0].arg, 'a.js');
  await p;
  assert.strictEqual(rec.phase, 'done');
  assert.strictEqual(ctx.Agent.status, 'idle');
});

test('activity record: FAILED sets phase failed and carries the real error message, not a generic string', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_b' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'FAILED', steps: [{ tool: 'bash', arg: 'npm test', done: true, ok: false }], changes: [], summary: [], reply: '', error: { message: 'Tests failed: 2 failing' } }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('run tests');
  const rec = ctx.Agent.history.find((m) => m.role === 'activity');
  assert.strictEqual(rec.phase, 'failed');
  assert.strictEqual(rec.error, 'Tests failed: 2 failing');
});

test('activity record: CANCELLED and UNCERTAIN map to their own distinct phases', async () => {
  const ctxCancel = setup({
    agentStart: () => Promise.resolve({ sessionId: 'c1' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'CANCELLED', steps: [], changes: [], summary: [], reply: '' }),
  });
  load(ctxCancel, ['app/js/agent.js']);
  ctxCancel.Agent.load('p1');
  await ctxCancel.Agent.sendMessage('stop this');
  assert.strictEqual(ctxCancel.Agent.history.find((m) => m.role === 'activity').phase, 'cancelled');

  const ctxUncertain = setup({
    agentStart: () => Promise.resolve({ sessionId: 'u1' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({ state: 'UNCERTAIN', steps: [], changes: [], summary: [], reply: '', error: { message: 'connection broke' } }),
  });
  load(ctxUncertain, ['app/js/agent.js']);
  ctxUncertain.Agent.load('p1');
  await ctxUncertain.Agent.sendMessage('do work');
  assert.strictEqual(ctxUncertain.Agent.history.find((m) => m.role === 'activity').phase, 'uncertain');
});

test('finished task: the system record carries real summary/changed-file/step fields for the outcome card', async () => {
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_c' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => Promise.resolve({
      state: 'SUCCESS', reply: '', error: null, snapshot: 'snap2',
      steps: [{ tool: 'write_file', arg: 'b.js', done: true, ok: true }, { tool: 'run_command', arg: 'npm test', done: true, ok: true }],
      changes: [{ path: 'b.js' }], summary: ['Edited b.js', 'Ran npm test'],
    }),
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  await ctx.Agent.sendMessage('add a test');
  const outcome = ctx.Agent.history.find((m) => m.role === 'system' && m.summaryLines);
  assert.ok(outcome, 'a structured outcome record exists');
  assert.deepStrictEqual(outcome.summaryLines, ['Edited b.js', 'Ran npm test']);
  assert.deepStrictEqual(outcome.changedPaths, ['b.js']);
  assert.ok(outcome.ranSteps.some((s) => s.tool === 'run' && s.arg === 'npm test'), 'the real run step is carried, not a fabricated test result');
});

test('no dead propose/apply/discard flow: agent.js has no pending field, reviewSheet, apply, or discard', () => {
  const src = read('app/js/agent.js');
  assert.ok(!/\bAgent\.pending\b/.test(src));
  assert.ok(!/reviewSheet/.test(src));
  assert.ok(!/P\.apply\s*=/.test(src));
  assert.ok(!/P\.discard\s*=/.test(src));
});

test('expand/collapse state lives on the activity record itself and is not reset by a later poll tick', async () => {
  let n = 0;
  const ctx = setup({
    agentStart: () => Promise.resolve({ sessionId: 'ses_d' }), agentSend: () => Promise.resolve({}),
    agentStatus: () => {
      n++;
      if (n < 3) return Promise.resolve({ state: 'RUNNING', steps: [{ tool: 'read_file', arg: 'x.js', done: n > 1, ok: true }], changes: [], summary: [] });
      return Promise.resolve({ state: 'SUCCESS', steps: [{ tool: 'read_file', arg: 'x.js', done: true, ok: true }], changes: [], summary: [], reply: 'ok', error: null, snapshot: null });
    },
  });
  load(ctx, ['app/js/agent.js']);
  ctx.Agent.load('p1');
  const p = ctx.Agent.sendMessage('look at x.js');
  await tick();
  const rec = ctx.Agent.history.find((m) => m.role === 'activity');
  rec.expanded = true;
  await until(() => n >= 2);
  assert.strictEqual(rec.expanded, true, 'a poll tick updating steps must not collapse an open activity card');
  await p;
});

test('startup automatically starts a stopped server instead of repeating a probe-only check', async () => {
  const calls = [];
  const ctx = setup({
    opencodeStatus: () => Promise.resolve({ state: 'SERVER_STOPPED', message: 'stopped' }),
    opencodeEnsure: (force) => {
      calls.push(force);
      return Promise.resolve(force
        ? { state: 'READY', message: 'OpenCode is ready.' }
        : { state: 'SERVER_STOPPED', message: 'The server is not running.' });
    },
    opencodeModels: () => Promise.resolve({ models: [], selected: 'auto' }),
  });
  load(ctx, ['app/js/opencode.js']);
  const result = await ctx.OpenCode.start();
  assert.deepStrictEqual(calls, [false, true]);
  assert.strictEqual(result.state, 'READY');
});

test('transitional OpenCode states are explained instead of classified as UNKNOWN', () => {
  const ctx = setup({});
  load(ctx, ['app/js/errors.js']);
  const result = ctx.Errors.classify('RESTARTING');
  assert.strictEqual(result.category, 'SERVER');
  assert.match(result.title, /still starting/i);
});


test('managed server monitor recovers after a real stopped-server probe when no task is active', async () => {
  const calls = [];
  const ctx = setup({
    opencodeModels: () => Promise.resolve({ models: [] }),
    opencodeStatus: () => Promise.resolve({ state: 'READY', managed: true, activeTasks: 0, port: 4096 }),
    opencodeRecheck: () => { calls.push('probe'); return Promise.resolve({ state: 'SERVER_STOPPED', managed: true, activeTasks: 0, code: 'SERVER_DOWN' }); },
    opencodeEnsure: (force) => { calls.push(['ensure', force]); return Promise.resolve({ state: 'READY', managed: true, activeTasks: 0, port: 4096 }); }
  });
  // Supply the methods expected by OpenCode.start().
  ctx.Bridge.opencodeModels = () => Promise.resolve({ models: [] });
  ctx.Bridge.opencodeStatus = () => Promise.resolve({ state: 'READY', managed: true, activeTasks: 0, port: 4096 });
  ctx.Bridge.opencodeEnsure = (force) => { calls.push(['ensure', force]); return Promise.resolve({ state: 'READY', managed: true, activeTasks: 0, port: 4096 }); };
  ctx.Bridge.opencodeRecheck = () => { calls.push('probe'); return Promise.resolve({ state: 'SERVER_STOPPED', managed: true, activeTasks: 0, code: 'SERVER_DOWN' }); };
  load(ctx, ['app/js/opencode.js']);
  await ctx.OpenCode.start();
  calls.length = 0;
  await ctx.OpenCode.monitorNow();
  assert.deepStrictEqual(plain(calls), ['probe', ['ensure', false]]);
  assert.strictEqual(ctx.OpenCode.status.state, 'READY');
});

test('managed server monitor does not restart during an active task or for a foreign server', async () => {
  for (const status of [
    { state: 'READY', managed: true, activeTasks: 1 },
    { state: 'READY', managed: false, activeTasks: 0 }
  ]) {
    let probes = 0, starts = 0;
    const ctx = setup({
      opencodeModels: () => Promise.resolve({ models: [] }),
      opencodeStatus: () => Promise.resolve(status),
      opencodeRecheck: () => { probes++; return Promise.resolve({ state: 'SERVER_STOPPED', managed: true, activeTasks: 0 }); },
      opencodeEnsure: () => { starts++; return Promise.resolve(status); }
    });
    load(ctx, ['app/js/opencode.js']);
    await ctx.OpenCode.start();
    probes = 0; starts = 0;
    ctx.OpenCode.set(status);
    await ctx.OpenCode.monitorNow();
    assert.strictEqual(probes, 0);
    assert.strictEqual(starts, 0);
  }
});