const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app/js/terminal.js'), 'utf8');

function setup(bridge, confirmAnswer) {
  const listeners = {};
  const ctx = vm.createContext({
    setTimeout, clearTimeout, console,
    UI: { h: () => ({}), toast() {}, dot() {}, copy() {}, confirm: () => Promise.resolve(confirmAnswer !== false) },
    Bus: { emit() {}, on() { return () => {}; } },
    Persist: { get: (k, d) => d, set() {} },
    Redact: { text: (s) => s },
    Errors: { classify: (e, code) => ({ category: 'X', simple: String(e.message), code }) },
    Bridge: Object.assign({
      on: (n, f) => { (listeners[n] = listeners[n] || []).push(f); }, off: (n, f) => { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
      emit: (n, d) => (listeners[n] || []).forEach((f) => f(d)),
    }, bridge),
  });
  ctx.window = ctx;
  vm.runInContext(src, ctx);
  return ctx;
}
const out = (T) => JSON.parse(JSON.stringify(T.lines.filter((l) => l.t === 'out').map((l) => l.s)));

test('streams live output line by line, strips ANSI, does not duplicate the final stdout', async () => {
  let ctx;
  ctx = setup({ runCommand: () => { ctx.Bridge.emit('terminal', { chunk: '\x1b[32mhel' }); ctx.Bridge.emit('terminal', { chunk: 'lo\x1b[0m\nwor' }); ctx.Bridge.emit('terminal', { chunk: 'ld\n' });
    return Promise.resolve({ stdout: 'hello\nworld\n', stderr: '', exitCode: 0, status: 'SUCCESS', cwd: '/p' }); } });
  await ctx.Terminal.exec('echo hi', 'user');
  assert.deepStrictEqual(out(ctx.Terminal), ['hello', 'world']);
  assert.strictEqual(ctx.Terminal.exit, 0);
  assert.strictEqual(ctx.Terminal.status, 'SUCCESS');
  assert.strictEqual(ctx.Terminal.running, false);
});

test('real statuses are shown: FAILED, TIMEOUT, CANCELLED', async () => {
  for (const [status, code, marker] of [['FAILED', 2, 'exit 2'], ['TIMEOUT', 124, 'timed out'], ['CANCELLED', 130, 'cancelled']]) {
    const ctx = setup({ runCommand: () => Promise.resolve({ stdout: '', stderr: '', exitCode: code, status }) });
    await ctx.Terminal.exec('x', 'user');
    assert.ok(ctx.Terminal.lines.some((l) => l.t === 'sys' && l.s.indexOf(marker) >= 0), status);
    assert.strictEqual(ctx.Terminal.status, status);
  }
});

test('fallback: stdout is shown when no live chunks arrived', async () => {
  const ctx = setup({ runCommand: () => Promise.resolve({ stdout: 'a\nb\n', stderr: '', exitCode: 0, status: 'SUCCESS' }) });
  await ctx.Terminal.exec('ls', 'user');
  assert.deepStrictEqual(out(ctx.Terminal), ['a', 'b']);
});

test('daemon CONFIRMATION_REQUIRED -> user confirms -> re-run with confirmed=true; declining does not run', async () => {
  const calls = [];
  const mk = (answer) => setup({ runCommand: (c, conf) => { calls.push(conf); if (!conf) { const e = new Error('needs review'); e.code = 'CONFIRMATION_REQUIRED'; return Promise.reject(e); } return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, status: 'SUCCESS' }); } }, answer);
  await mk(true).Terminal.exec('somecmd', 'user');
  assert.deepStrictEqual(calls, [false, true]);
  calls.length = 0;
  const c2 = mk(false);
  await c2.Terminal.exec('somecmd', 'user');
  assert.deepStrictEqual(calls, [false]);
  assert.ok(c2.Terminal.lines.some((l) => l.s === 'Not run.'));
});

test('native errors are shown as errors (COMMAND_NOT_ALLOWED is not dressed up)', async () => {
  const ctx = setup({ runCommand: () => { const e = new Error('"sh" is not on the allowed command list.'); e.code = 'COMMAND_NOT_ALLOWED'; return Promise.reject(e); } });
  await ctx.Terminal.exec('sh', 'user');
  assert.ok(ctx.Terminal.lines.some((l) => l.t === 'err' && /not on the allowed/.test(l.s)));
  assert.strictEqual(ctx.Terminal.running, false);
  assert.strictEqual(ctx.Terminal.status, 'FAILED');
});

test('stop calls the real cancel; Ctrl+C calls the real interrupt; input goes to real stdin', async () => {
  const calls = [];
  let release;
  const ctx = setup({
    runCommand: () => new Promise((r) => { release = r; }),
    cancelCommand: () => { calls.push('cancel'); return Promise.resolve({}); },
    interruptCommand: () => { calls.push('interrupt'); return Promise.resolve({}); },
    sendInput: (d) => { calls.push('stdin:' + JSON.stringify(d)); return Promise.resolve({}); },
  });
  const p = ctx.Terminal.exec('node server.js', 'user');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(ctx.Terminal.running, true);
  await ctx.Terminal.sendInput('yes');
  ctx.Terminal.interrupt();
  ctx.Terminal.cancel();
  assert.deepStrictEqual(calls, ['stdin:"yes\\n"', 'interrupt', 'cancel']);
  release({ stdout: '', stderr: '', exitCode: 130, status: 'CANCELLED' });
  await p;
  assert.strictEqual(ctx.Terminal.status, 'CANCELLED');
  assert.strictEqual(ctx.Terminal.running, false);
});
