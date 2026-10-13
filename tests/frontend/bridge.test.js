// Frontend tests (node >= 18):  node --test tests/frontend
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function load(window, files) {
  const ctx = vm.createContext(Object.assign({ setTimeout, clearTimeout, console, Promise, JSON }, window));
  ctx.window = ctx;
  files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  return ctx;
}

// A fake Android side that answers exactly like NativeBridge does (same envelope).
function fakeNative(handler) {
  const sent = [];
  const nb = {
    sent,
    request(json) {
      const req = JSON.parse(json);
      sent.push(req);
      setImmediate(() => {
        let reply;
        try { reply = { success: true, data: handler(req.method, req.args), error: null, requestId: req.requestId }; }
        catch (e) { reply = { success: false, data: null, error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || null }, requestId: req.requestId }; }
        ctx.__bridgeResolve(req.requestId, JSON.stringify(reply));
      });
    },
  };
  let ctx;
  return { nb, bind: (c) => { ctx = c; } };
}

test('production without native bridge: real error, never a mock answer', async () => {
  const ctx = load({}, ['app/js/bridge.js']);
  assert.strictEqual(ctx.Bridge.mode, 'none');
  await assert.rejects(ctx.Bridge.listProjects(), (e) => e.code === 'BRIDGE_UNAVAILABLE');
  await assert.rejects(ctx.Bridge.runCommand('ls'), (e) => e.code === 'BRIDGE_UNAVAILABLE');
  await assert.rejects(ctx.Bridge.call('setChaos', {}), (e) => e.code === 'UNKNOWN_METHOD');   // mock controls do not exist in production
});

test('index.html (the APK UI) does not load the mock; dev.html does', () => {
  assert.ok(!/mock\.js/.test(read('app/index.html')));
  assert.ok(/dev\/mock\.js/.test(read('app/dev.html')));
});

test('success and error envelopes are unwrapped; BridgeError carries code/details', async () => {
  const f = fakeNative((m, a) => {
    if (m === 'readFile') { const e = new Error('not there'); e.code = 'NOT_FOUND'; e.details = 'x'; throw e; }
    return { echo: m, args: a };
  });
  const ctx = load({ AndroidBridge: f.nb }, ['app/js/bridge.js']);
  f.bind(ctx);
  assert.strictEqual(ctx.Bridge.mode, 'native');
  const ok = await ctx.Bridge.listFiles('src');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ok.args)), { path: 'src' });
  await assert.rejects(ctx.Bridge.readFile('a'), (e) => e.name === 'BridgeError' && e.code === 'NOT_FOUND' && e.details === 'x');
});

test('every request carries a unique requestId and the reply is matched to it', async () => {
  const f = fakeNative((m) => m);
  const ctx = load({ AndroidBridge: f.nb }, ['app/js/bridge.js']);
  f.bind(ctx);
  const r = await Promise.all([ctx.Bridge.listProjects(), ctx.Bridge.getEnvironment(), ctx.Bridge.healthCheck()]);
  assert.deepStrictEqual(r, ['listProjects', 'getEnvironment', 'healthCheck']);
  assert.strictEqual(new Set(f.nb.sent.map((s) => s.requestId)).size, 3);
});

test('unknown methods are refused before reaching native; no generic exec entry exists', async () => {
  const f = fakeNative(() => null);
  const ctx = load({ AndroidBridge: f.nb }, ['app/js/bridge.js']);
  f.bind(ctx);
  for (const m of ['execute', 'executeAnything', 'eval', 'shell']) {
    await assert.rejects(ctx.Bridge.call(m, { command: 'id' }), (e) => e.code === 'UNKNOWN_METHOD');
  }
  assert.strictEqual(f.nb.sent.length, 0);
});

test('native events reach listeners; listener errors are contained', () => {
  const ctx = load({ AndroidBridge: { request() {} } }, ['app/js/bridge.js']);
  const got = [];
  ctx.Bridge.on('terminal', (d) => got.push(d.chunk));
  ctx.Bridge.on('terminal', () => { throw new Error('boom'); });
  ctx.__bridgeEvent('terminal', JSON.stringify({ chunk: 'a' }));
  ctx.__bridgeEvent('terminal', 'not json');
  assert.deepStrictEqual(got, ['a']);
});

test('invalid native reply becomes BAD_RESPONSE, not a crash', async () => {
  let ctx;
  const nb = { request(json) { const id = JSON.parse(json).requestId; setImmediate(() => ctx.__bridgeResolve(id, '{{{')); } };
  ctx = load({ AndroidBridge: nb }, ['app/js/bridge.js']);
  await assert.rejects(ctx.Bridge.listProjects(), (e) => e.code === 'BAD_RESPONSE');
});

test('contract: JS method allowlist == NativeBridge.java dispatch cases', () => {
  const js = read('app/js/bridge.js');
  const arr = js.slice(js.indexOf('var METHODS = ['), js.indexOf('];', js.indexOf('var METHODS = [')));
  const jsMethods = new Set([...arr.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
  const java = read('app/java/NativeBridge.java');
  const body = java.slice(java.indexOf('private Object dispatch('), java.indexOf('// ------------------------------------------------------------ helpers'));
  const javaMethods = new Set([...body.matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]));
  assert.deepStrictEqual([...jsMethods].filter((m) => !javaMethods.has(m)), [], 'in JS but not handled in Java');
  assert.deepStrictEqual([...javaMethods].filter((m) => !jsMethods.has(m)), [], 'in Java but not callable from JS');
});

test('contract: every Bridge.xxx() called by a UI module exists in bridge.js', () => {
  const ctx = load({ AndroidBridge: { request() {} } }, ['app/js/bridge.js']);
  const used = new Set();
  fs.readdirSync(path.join(root, 'app/js')).filter((f) => f.endsWith('.js') && f !== 'bridge.js').forEach((f) => {
    for (const m of read('app/js/' + f).matchAll(/Bridge\.([A-Za-z]+)\(/g)) used.add(m[1]);
  });
  const missing = [...used].filter((m) => typeof ctx.Bridge[m] !== 'function' && !['setChaos', 'getChaos', 'resetDemo'].includes(m));
  assert.deepStrictEqual(missing, []);
});

test('no API key handling in JS: nothing reads or stores a secret value', () => {
  for (const f of fs.readdirSync(path.join(root, 'app/js')).filter((x) => x.endsWith('.js'))) {
    const src = read('app/js/' + f);
    assert.ok(!/localStorage\.setItem\([^)]*(key|secret|token)/i.test(src), f);
    assert.ok(!/getSecret/.test(src), f + ' must not have a getSecret');
  }
  assert.ok(!/getSecret|readSecret/.test(read('app/java/NativeBridge.java')), 'no bridge method may return a secret');
});
