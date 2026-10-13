/* mock.js — in-browser stand-in for the Android bridge.
   Implements the SAME contract as NativeBridge.java so the UI can be built and
   tested in any browser. It enforces the same rules as the native side:
   project-root confinement, size limits, command allowlist, confirmation for
   destructive commands, and structured {success,data,error,requestId} replies.
   It also contains "chaos" switches so recovery flows can be exercised. */
(function (g) {
  'use strict';

  var MAX_READ = 1000000;
  var KNOWN_GOOD_NODE = '20.11.1';
  var ALLOWED_BIN = ['ls', 'cat', 'pwd', 'echo', 'head', 'wc', 'rm', 'touch', 'node', 'npm', 'git', 'which', 'uname', 'whoami', 'date', 'help', 'clear'];
  var DESTRUCTIVE = /(^|\s)(rm|mv|chmod|chown|dd|kill)\b|git\s+(reset\s+--hard|clean|push\s+.*(--force|-f\b)|checkout\s+--|branch\s+-D|stash\s+drop)|>\s*\S|\|\s*sh\b/;

  function E(code, message, details) {
    var e = new Error(message);
    e.code = code;
    e.details = details || null;
    return e;
  }

  var P1_HEAD = {
    'README.md': '# Axiom Engine\n\nA tiny 2D simulation core.\n\n## Usage\n\n    npm test\n',
    'package.json': '{\n  "name": "axiom-engine",\n  "version": "0.3.0",\n  "scripts": { "test": "node test/engine.test.js" },\n  "license": "MIT"\n}\n',
    '.gitignore': 'node_modules/\n*.log\n',
    'src/physics.js': '// Small math helpers used by the engine.\nfunction clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}\n\nfunction lerp(a, b, t) {\n  return a + (b - a) * clamp(t, 0, 1);\n}\n\nmodule.exports = { clamp, lerp };\n',
    'src/engine.js': "const { clamp } = require('./physics');\n\nclass Engine {\n  constructor() {\n    this.entities = [];\n    this.time = 0;\n  }\n\n  add(entity) {\n    this.entities.push(entity);\n    return this.entities.length - 1;\n  }\n\n  step(dt) {\n    this.time += dt;\n    for (const e of this.entities) {\n      e.x = clamp(e.x + e.vx * dt, 0, 100);\n      e.y = clamp(e.y + e.vy * dt, 0, 100);\n    }\n  }\n}\n\nmodule.exports = { Engine };\n",
    'test/engine.test.js': "const assert = require('assert');\nconst { Engine } = require('../src/engine');\n\nconst engine = new Engine();\nconst id = engine.add({ x: 0, y: 0, vx: 10, vy: 5 });\nengine.step(1);\nassert.strictEqual(engine.entities[id].x, 10);\nconsole.log('engine: ok');\n"
  };
  var P2_HEAD = {
    'README.md': '# Notes CLI\n\nCapture notes from the terminal.\n',
    'package.json': '{\n  "name": "notes-cli",\n  "version": "1.0.0",\n  "scripts": { "test": "node index.js" }\n}\n',
    'index.js': "const notes = [];\nfunction add(text) {\n  notes.push({ text, at: Date.now() });\n}\nadd('hello');\nconsole.log(notes.length + ' note(s)');\n"
  };

  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  function freshDb() {
    var p1fs = copy(P1_HEAD);
    p1fs['README.md'] += '\nStatus: prototype\n';
    var now = Date.now();
    return {
      active: null,
      backend: 'local',
      projects: [
        { id: 'p1', name: 'Axiom Engine', backend: 'termux', agent: 'opencode', updated: now - 3600e3 },
        { id: 'p2', name: 'Notes CLI', backend: 'termux', agent: 'opencode', updated: now - 5 * 86400e3 }
      ],
      data: {
        p1: { fs: p1fs, head: copy(P1_HEAD), branch: 'main', log: [{ hash: 'a3f9c21', msg: 'Add engine step and clamp', at: now - 2 * 86400e3 }, { hash: '71be0d4', msg: 'Initial commit', at: now - 9 * 86400e3 }] },
        p2: { fs: copy(P2_HEAD), head: copy(P2_HEAD), branch: 'main', log: [{ hash: 'c0de111', msg: 'Initial commit', at: now - 20 * 86400e3 }] }
      },
      secrets: { hosted: true },   // presence flags only; values are never kept
      snapshots: [{ id: 's0', label: 'Initial setup (passed health checks)', at: now - 7 * 86400e3, env: { node: KNOWN_GOOD_NODE, agent: '0.15.2' }, good: true }],
      env: { node: '22.5.0', agent: '0.15.2' },
      chaos: {},
      netRetries: 0
    };
  }

  var db = (function () {
    var saved = Persist.get('mock.db', null);
    return saved || freshDb();
  })();
  function save() { Persist.set('mock.db', db); }

  /* ---------- path safety (mirrors PathGuard in NativeBridge.java) ---------- */
  function norm(p) {
    if (typeof p !== 'string') throw E('INVALID_ARGUMENT', 'Path must be a string.');
    if (p.indexOf('\0') >= 0) throw E('INVALID_ARGUMENT', 'Path contains an invalid character.');
    var parts = [];
    p.replace(/\\/g, '/').split('/').forEach(function (s) {
      if (!s || s === '.') return;
      if (s === '..') {
        if (!parts.length) throw E('PATH_OUTSIDE_PROJECT', 'That path is outside the project folder.');
        parts.pop();
      } else parts.push(s);
    });
    return parts.join('/');
  }
  function proj() {
    if (!db.active) throw E('NO_PROJECT', 'No project is open.');
    return db.data[db.active];
  }

  function listDir(path) {
    var fs = proj().fs, prefix = path ? path + '/' : '', seen = {}, out = [];
    Object.keys(fs).forEach(function (f) {
      if (prefix && f.indexOf(prefix) !== 0) return;
      var rest = f.slice(prefix.length);
      if (!rest) return;
      var slash = rest.indexOf('/');
      if (slash < 0) out.push({ name: rest, path: f, type: 'file', size: fs[f].length });
      else {
        var d = rest.slice(0, slash);
        if (!seen[d]) { seen[d] = 1; out.push({ name: d, path: prefix + d, type: 'dir', size: 0 }); }
      }
    });
    out.sort(function (a, b) { return a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1); });
    return out;
  }

  function gitStatus() {
    var p = proj(), out = [];
    Object.keys(p.fs).forEach(function (f) {
      if (!(f in p.head)) out.push({ path: f, code: '?' });
      else if (p.head[f] !== p.fs[f]) out.push({ path: f, code: 'M' });
    });
    Object.keys(p.head).forEach(function (f) { if (!(f in p.fs)) out.push({ path: f, code: 'D' }); });
    out.sort(function (a, b) { return a.path.localeCompare(b.path); });
    return out;
  }
  function gitDiffText(path) {
    var p = proj(), text = '';
    gitStatus().forEach(function (s) {
      if (path && s.path !== path) return;
      var d = Diff.diffFile(s.path, p.head[s.path], p.fs[s.path], 2);
      text += 'diff --git a/' + s.path + ' b/' + s.path + '\n';
      d.lines.forEach(function (l) { text += (l.t === '~' ? '@@ ' + l.s + ' @@' : l.t + l.s) + '\n'; });
    });
    return text;
  }

  function tokenize(cmd) {
    var out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g, m;
    while ((m = re.exec(cmd))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
  }

  function npmTest() {
    var p = proj(), out = [], code = 0;
    var t = p.fs['test/engine.test.js'];
    if (!t) return { stdout: '', stderr: 'npm ERR! missing script: test\n', exitCode: 1 };
    out.push('> ' + (JSON.parse(p.fs['package.json'] || '{}').name || 'project') + '@test');
    out.push('engine: ok');
    if (/rejects invalid dt/.test(t)) {
      if (/isFinite/.test(p.fs['src/engine.js'] || '')) out.push('engine: rejects invalid dt: ok');
      else { return { stdout: out.join('\n') + '\n', stderr: 'AssertionError [ERR_ASSERTION]: Missing expected exception (RangeError).\n    at test/engine.test.js:12\n', exitCode: 1 }; }
    }
    if (/lerp clamps/.test(t)) out.push('physics: lerp clamps: ok');
    return { stdout: out.join('\n') + '\n', stderr: '', exitCode: code };
  }

  function runCommand(a) {
    var cmd = String(a.command || '').trim();
    if (!cmd) return { stdout: '', stderr: '', exitCode: 0 };
    var p = proj();
    var t = tokenize(cmd), bin = t[0], args = t.slice(1);
    if (ALLOWED_BIN.indexOf(bin) < 0) throw E('COMMAND_NOT_ALLOWED', '"' + bin + '" is not on the allowed command list.');
    if (DESTRUCTIVE.test(cmd) && !a.confirmed) throw E('CONFIRMATION_REQUIRED', 'This command can destroy data and needs review before it runs.');
    var ok = function (s) { return { stdout: s ? s + '\n' : '', stderr: '', exitCode: 0 }; };
    var fail = function (s, c) { return { stdout: '', stderr: s + '\n', exitCode: c || 1 }; };
    switch (bin) {
      case 'help': return ok('Allowed: ' + ALLOWED_BIN.join(' '));
      case 'clear': return ok('');
      case 'pwd': return ok('~/projects/' + (db.projects.filter(function (x) { return x.id === db.active; })[0] || {}).name);
      case 'whoami': return ok('u0_a312');
      case 'date': return ok(new Date().toString());
      case 'uname': return ok(db.backend === 'remote' ? 'Linux x86_64' : 'Linux aarch64 Android');
      case 'echo': return ok(args.join(' '));
      case 'which': return ok(args[0] ? '/data/data/com.termux/files/usr/bin/' + args[0] : '');
      case 'ls': {
        var dir = norm(args.filter(function (x) { return x[0] !== '-'; })[0] || '');
        var items = listDir(dir);
        if (!items.length && dir) return fail('ls: cannot access \'' + dir + '\': No such file or directory', 2);
        return ok(items.map(function (i) { return i.name + (i.type === 'dir' ? '/' : ''); }).join('\n'));
      }
      case 'cat': {
        var f = norm(args[0] || '');
        if (!(f in p.fs)) return fail('cat: ' + f + ': No such file or directory');
        return { stdout: p.fs[f], stderr: '', exitCode: 0 };
      }
      case 'head': {
        var f2 = norm(args[args.length - 1] || '');
        if (!(f2 in p.fs)) return fail('head: ' + f2 + ': No such file or directory');
        return ok(p.fs[f2].split('\n').slice(0, 10).join('\n'));
      }
      case 'wc': {
        var f3 = norm(args[args.length - 1] || '');
        if (!(f3 in p.fs)) return fail('wc: ' + f3 + ': No such file or directory');
        return ok(p.fs[f3].split('\n').length - 1 + ' ' + f3);
      }
      case 'touch': args.forEach(function (x) { var n = norm(x); if (!(n in p.fs)) p.fs[n] = ''; }); save(); return ok('');
      case 'rm': {
        var rmArgs = args.filter(function (x) { return x[0] !== '-'; });
        for (var i = 0; i < rmArgs.length; i++) {
          var n2 = norm(rmArgs[i]);
          if (!(n2 in p.fs)) return fail('rm: cannot remove \'' + n2 + '\': No such file or directory');
          delete p.fs[n2];
        }
        save();
        return ok('');
      }
      case 'node': return args[0] === '-v' || args[0] === '--version' ? ok('v' + db.env.node) : fail('node: running scripts is not available in the prototype');
      case 'npm':
        if (args[0] === '-v') return ok('10.8.2');
        if (args[0] === 'test' || args[0] === 't') return npmTest();
        return fail('npm: only "npm test" is simulated in the prototype');
      case 'git': return runGit(args);
    }
    return fail('unsupported', 127);
  }

  function runGit(args) {
    var p = proj(), sub = args[0];
    var ok = function (s) { return { stdout: s ? s + '\n' : '', stderr: '', exitCode: 0 }; };
    if (sub === 'status') {
      var st = gitStatus();
      if (!st.length) return ok('On branch ' + p.branch + '\nnothing to commit, working tree clean');
      return ok('On branch ' + p.branch + '\nChanges:\n' + st.map(function (s) { return '  ' + s.code + ' ' + s.path; }).join('\n'));
    }
    if (sub === 'diff') return ok(gitDiffText(args[1]).trimEnd());
    if (sub === 'log') return ok(p.log.map(function (l) { return l.hash + ' ' + l.msg; }).join('\n'));
    if (sub === 'branch') return ok('* ' + p.branch);
    if (sub === 'fetch' || sub === 'pull') return ok('Already up to date.');
    if (sub === 'push') return ok('Everything up-to-date (mock remote)');
    if (sub === 'stash') return ok('No local changes to save');
    if (sub === 'commit' || sub === 'add' || sub === 'checkout' || sub === 'restore' || sub === 'reset' || sub === 'clean') {
      return { stdout: '', stderr: 'git ' + sub + ': use the Git tab in the prototype\n', exitCode: 1 };
    }
    return { stdout: '', stderr: 'git: \'' + (sub || '') + '\' is not supported here\n', exitCode: 1 };
  }

  /* ---------- environment / health ---------- */
  function envInfo() {
    var remote = db.backend === 'remote';
    return {
      backend: db.backend,
      android: remote ? null : { version: '14', api: 34 },
      arch: remote ? 'x86_64' : 'arm64-v8a',
      termux: remote ? null : '0.118.1',
      shell: 'bash 5.2.21',
      git: '2.45.2',
      runtimes: { node: db.env.node },
      pty: true,
      storageFreeMB: !remote && db.chaos.lowStorage ? 38 : 4300,
      network: remote || !db.chaos.network,
      agent: { name: 'opencode', version: db.env.agent },
      remoteHost: remote ? 'dev.example.net' : null
    };
  }

  function healthChecks() {
    var env = envInfo(), c = db.chaos, remote = db.backend === 'remote';
    var k = function (key, name, status, detail, raw) { return { key: key, name: name, status: status, detail: detail, raw: raw || null }; };
    var out = [];
    out.push(k('os', 'Android', 'ok', remote ? 'Remote Linux workspace' : 'Android ' + env.android.version + ' (API ' + env.android.api + ')'));
    out.push(k('arch', 'Architecture', 'ok', env.arch === 'arm64-v8a' ? 'ARM64' : env.arch));
    out.push(k('termux', remote ? 'Backend' : 'Termux', 'ok', remote ? 'Remote: ' + env.remoteHost : 'Termux ' + env.termux));
    out.push(k('shell', 'Shell', 'ok', env.shell));
    out.push(k('git', 'Git', 'ok', 'git ' + env.git));
    out.push(k('runtime', 'Runtime', 'ok', 'Node ' + env.runtimes.node));
    out.push(k('pty', 'PTY', 'ok', 'Pseudo-terminal available'));
    if (!remote && c.lowStorage) out.push(k('storage', 'Storage', 'failed', 'Only 38 MB free', 'ENOSPC: no space left on device, write'));
    else out.push(k('storage', 'Storage', 'ok', '4.2 GB free'));
    if (!remote && c.network) out.push(k('network', 'Network', 'failed', 'No connection', 'getaddrinfo ENOTFOUND api.example.com'));
    else out.push(k('network', 'Network', 'ok', 'Online'));
    if (!remote && c.agentSyntax) out.push(k('agent', 'OpenCode', 'failed', 'OpenCode ' + db.env.agent + ' fails to load on Node ' + db.env.node, 'SyntaxError: Invalid or unexpected token\n    at wrapSafe (node:internal/modules/cjs/loader:1469:18)\n    at node_modules/opencode/dist/cli.js:1'));
    else if (!remote && c.nativeLib) out.push(k('agent', 'OpenCode', 'failed', 'Missing native library', 'Error: dlopen failed: library "libc++_shared.so" not found\n    at node_modules/opencode/native/pty.node'));
    else if (!remote && c.processKilled) out.push(k('agent', 'OpenCode', 'failed', 'Agent process stopped', 'Process exited with signal SIGKILL (exit code 137)'));
    else out.push(k('agent', 'OpenCode', 'ok', 'OpenCode ' + db.env.agent));
    return out;
  }

  function agentFailure() {
    var h = healthChecks().filter(function (x) { return x.key === 'agent' && x.status !== 'ok'; })[0];
    if (h) throw E('AGENT_START_FAILED', 'OpenCode failed to start', h.raw);
  }

  /* ---------- agent simulation ---------- */
  function planFor(message) {
    var m = String(message).toLowerCase(), p = proj();
    var eng = p.fs['src/engine.js'], tst = p.fs['test/engine.test.js'], readme = p.fs['README.md'];
    var steps, reply, changes = [];
    if (/readme|doc/.test(m) && readme != null) {
      steps = [{ tool: 'read', arg: 'README.md', ms: 500 }, { tool: 'read', arg: 'package.json', ms: 400 }, { tool: 'write', arg: 'README.md', ms: 700 }];
      reply = 'I updated the README with install and test instructions, and removed the placeholder status line.';
      changes.push({ path: 'README.md', newContent: '# ' + (JSON.parse(p.fs['package.json'] || '{}').name || 'Project') + '\n\nA tiny 2D simulation core.\n\n## Setup\n\n    npm install\n\n## Usage\n\n    npm test\n' });
    } else if (/lerp|physics/.test(m) || (/test/.test(m) && !/dt|guard|valid/.test(m))) {
      steps = [{ tool: 'read', arg: 'src/physics.js', ms: 500 }, { tool: 'read', arg: 'test/engine.test.js', ms: 400 }, { tool: 'write', arg: 'test/engine.test.js', ms: 800 }, { tool: 'run', arg: 'npm test', ms: 700 }];
      reply = 'I added a test showing that lerp clamps t to the 0–1 range. Review the change, apply it, then run the tests.';
      if (tst != null) changes.push({ path: 'test/engine.test.js', newContent: tst.replace("console.log('engine: ok');", "console.log('engine: ok');\n\nconst { lerp } = require('../src/physics');\nassert.strictEqual(lerp(0, 10, 2), 10);\nconsole.log('physics: lerp clamps: ok');") });
    } else {
      steps = [{ tool: 'search', arg: 'step(', ms: 450 }, { tool: 'read', arg: 'src/engine.js', ms: 500 }, { tool: 'write', arg: 'src/engine.js', ms: 800 }, { tool: 'write', arg: 'test/engine.test.js', ms: 700 }, { tool: 'run', arg: 'npm test', ms: 700 }];
      reply = 'Engine.step accepted NaN, negative and infinite time steps, which would corrupt every entity. I added a guard that throws a RangeError, plus a test for it.';
      if (eng != null) changes.push({ path: 'src/engine.js', newContent: eng.replace('  step(dt) {\n', "  step(dt) {\n    if (!Number.isFinite(dt) || dt < 0) {\n      throw new RangeError('dt must be a non-negative number');\n    }\n") });
      if (tst != null) changes.push({ path: 'test/engine.test.js', newContent: tst.replace("console.log('engine: ok');", "console.log('engine: ok');\n\nassert.throws(() => engine.step(NaN), RangeError);\nconsole.log('engine: rejects invalid dt: ok');") });
    }
    changes = changes.filter(function (c) { return c.newContent !== p.fs[c.path]; });
    if (!changes.length) reply = 'Nothing to change — the project already matches what you asked for.';
    return { steps: steps, reply: reply, changes: changes };
  }

  /* ---------- provider simulation ---------- */
  function providerHealth(id) {
    var c = db.chaos, has = !!db.secrets[id];
    if (id === 'local') return { status: 'ok', detail: 'On-device model ready (slower, offline)', latencyMs: 900 };
    if (c.network && db.backend !== 'remote') return { status: 'failed', detail: 'No connection', raw: 'getaddrinfo ENOTFOUND api.example.com' };
    if (!has) return { status: 'warning', detail: 'No API key saved', raw: 'No API key saved for this provider (HTTP 401 would follow)' };
    if (id === 'hosted' && c.providerOutage) return { status: 'failed', detail: 'Provider outage', raw: '503 Service Unavailable: upstream provider overloaded (request req_8f2c)' };
    return { status: 'ok', detail: 'Key accepted', latencyMs: 180 + Math.round(Math.random() * 120) };
  }

  function mockOc() {
    return { state: 'READY', code: null, message: 'DEVELOPMENT MOCK: not a real OpenCode server.', detail: null, managed: false, workspace: '/storage/emulated/0/Download/opencode-si', port: 4096, version: 'mock', authEnforced: null, workspaceVerified: false, activeTasks: 0 };
  }

  /* ---------- method table ---------- */
  var M = {
    getEnvironment: function () { return envInfo(); },
    healthCheck: function () {
      var checks = healthChecks();
      var status = checks.some(function (c) { return c.status === 'failed'; }) ? 'failed' : checks.some(function (c) { return c.status === 'warning'; }) ? 'warning' : 'ok';
      return { status: status, checks: checks };
    },
    listProjects: function () { return db.projects.slice().sort(function (a, b) { return b.updated - a.updated; }); },
    createProject: function (a) {
      var name = String(a.name || '').trim();
      if (!name) throw E('INVALID_ARGUMENT', 'Project name is required.');
      if (db.projects.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })) throw E('INVALID_ARGUMENT', 'A project named "' + name + '" already exists.');
      var id = 'p' + Date.now().toString(36);
      var files = { 'README.md': '# ' + name + '\n', 'package.json': '{\n  "name": "' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '",\n  "version": "0.1.0"\n}\n' };
      var meta = { id: id, name: name, backend: 'termux', agent: 'opencode', updated: Date.now() };
      db.projects.push(meta);
      db.data[id] = { fs: copy(files), head: copy(files), branch: 'main', log: [{ hash: Math.random().toString(16).slice(2, 9), msg: 'Initial commit', at: Date.now() }] };
      save();
      return meta;
    },
    cloneProject: function (a) {
      var url = String(a.url || '').trim();
      if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw E('INVALID_ARGUMENT', 'Enter an https:// or ssh repository URL.');
      var name = url.replace(/\.git$/, '').split(/[\/:]/).pop() || 'cloned-repo';
      return M.createProject({ name: name });
    },
    importZip: function () { throw E('NOT_IMPLEMENTED', 'ZIP import needs the Android app (file picker).'); },
    openProject: function (a) {
      var p = db.projects.filter(function (x) { return x.id === a.id; })[0];
      if (!p) throw E('NOT_FOUND', 'Project not found.');
      p.updated = Date.now();
      db.active = p.id;
      save();
      return p;
    },
    listFiles: function (a) {
      var d = norm(a.path || '');
      return listDir(d);
    },
    readFile: function (a) {
      var f = norm(a.path), fs = proj().fs;
      if (!(f in fs)) throw E('NOT_FOUND', 'File not found: ' + f);
      if (fs[f].length > MAX_READ) throw E('FILE_TOO_LARGE', 'File is larger than 1 MB. Use the terminal (head, wc) instead.');
      return { path: f, content: fs[f], size: fs[f].length };
    },
    writeFile: function (a) {
      var f = norm(a.path);
      if (!f) throw E('INVALID_ARGUMENT', 'File name is required.');
      if (typeof a.content !== 'string') throw E('INVALID_ARGUMENT', 'Content must be text.');
      if (a.content.length > MAX_READ) throw E('FILE_TOO_LARGE', 'Content is larger than 1 MB.');
      if (db.chaos.lowStorage && db.backend !== 'remote') throw E('STORAGE_FULL', 'Could not save the file.', 'ENOSPC: no space left on device, write');
      proj().fs[f] = a.content;
      save();
      return { path: f, size: a.content.length };
    },
    createFile: function (a) {
      var f = norm(a.path), fs = proj().fs;
      if (!f) throw E('INVALID_ARGUMENT', 'File name is required.');
      if (f in fs) throw E('ALREADY_EXISTS', 'A file named ' + f + ' already exists.');
      fs[f] = a.content || '';
      save();
      return { path: f, size: fs[f].length };
    },
    deleteFile: function (a) {
      var f = norm(a.path), fs = proj().fs, hit = false;
      Object.keys(fs).forEach(function (k) { if (k === f || k.indexOf(f + '/') === 0) { delete fs[k]; hit = true; } });
      if (!hit) throw E('NOT_FOUND', 'Nothing to delete at ' + f);
      save();
      return { path: f };
    },
    moveFile: function (a) {
      var from = norm(a.from), to = norm(a.to), fs = proj().fs, hit = false;
      if (!to) throw E('INVALID_ARGUMENT', 'Destination is required.');
      Object.keys(fs).forEach(function (k) {
        if (k === from || k.indexOf(from + '/') === 0) {
          var dest = to + k.slice(from.length);
          if (dest in fs) throw E('ALREADY_EXISTS', dest + ' already exists.');
          fs[dest] = fs[k]; delete fs[k]; hit = true;
        }
      });
      if (!hit) throw E('NOT_FOUND', 'Nothing to move at ' + from);
      save();
      return { from: from, to: to };
    },
    exists: function (a) { return { exists: norm(a.path) in proj().fs }; },
    searchFiles: function (a) {
      var q = String(a.query || '').toLowerCase(), fs = proj().fs, out = [];
      if (q.length < 2) return [];
      Object.keys(fs).sort().forEach(function (f) {
        if (out.length >= 50) return;
        if (f.toLowerCase().indexOf(q) >= 0) out.push({ path: f, line: 0, text: 'File name match' });
        fs[f].split('\n').forEach(function (line, i) {
          if (out.length < 50 && line.toLowerCase().indexOf(q) >= 0) out.push({ path: f, line: i + 1, text: line.trim().slice(0, 120) });
        });
      });
      return out;
    },
    runCommand: runCommand,
    cancelCommand: function () { return { cancelled: true }; },
    resizeTerminal: function (a) { return { cols: a.cols, rows: a.rows }; },
    gitStatus: function () { var p = proj(); return { branch: p.branch, files: gitStatus() }; },
    gitDiff: function (a) { return { text: gitDiffText(a && a.path ? norm(a.path) : null) }; },
    gitLog: function () { return proj().log.slice(0, 20); },
    gitCommit: function (a) {
      var p = proj(), msg = String(a.message || '').trim();
      if (!msg) throw E('INVALID_ARGUMENT', 'A commit message is required.');
      if (!gitStatus().length) throw E('GIT_NOTHING', 'nothing to commit, working tree clean', 'nothing to commit, working tree clean');
      p.head = copy(p.fs);
      var entry = { hash: Math.random().toString(16).slice(2, 9), msg: msg, at: Date.now() };
      p.log.unshift(entry);
      save();
      return entry;
    },
    gitRestore: function (a) {
      var p = proj(), f = norm(a.path);
      if (f in p.head) p.fs[f] = p.head[f];
      else delete p.fs[f];
      save();
      return { path: f };
    },
    agentStart: function () {
      agentFailure();
      return { sessionId: 's' + Date.now().toString(36), agent: 'opencode', version: db.env.agent };
    },
    agentSend: function (a) {
      agentFailure();
      if (db.chaos.providerOutage) throw E('PROVIDER_ERROR', 'The provider request failed', '503 Service Unavailable: upstream provider overloaded (request req_8f2c)');
      if (db.chaos.network && db.backend !== 'remote') throw E('NETWORK_ERROR', 'Could not reach the provider', 'getaddrinfo ENOTFOUND api.example.com');
      return planFor(a.message);
    },
    agentCancel: function () { return { cancelled: true }; },
    agentHistory: function () { return []; },
    /* DEVELOPMENT MOCK of the OpenCode server lifecycle: nothing here talks to Termux or OpenCode. */
    opencodeStatus: function () { return mockOc(); },
    opencodeEnsure: function () { return mockOc(); },
    opencodeRecheck: function () { return mockOc(); },
    opencodeStop: function () { return mockOc(); },
    opencodeDiagnostics: function () { return { status: mockOc(), lines: ['DEVELOPMENT MOCK: no real server'] }; },
    opencodeSetupChecks: function () { return [{ key: 'mock', name: 'Development mock', status: 'warning', detail: 'dev.html does not talk to Termux or OpenCode.', raw: null }]; },
    opencodeGetWorkspace: function () { return { mode: 'custom', custom: '/storage/emulated/0/Download/opencode-si', default: '/storage/emulated/0/Download/opencode-si', effective: '/storage/emulated/0/Download/opencode-si' }; },
    opencodeSetWorkspace: function () { return M.opencodeGetWorkspace(); },
    opencodePickWorkspace: function () { return { requested: true }; },
    opencodeSetPassword: function () { return { stored: true }; },
    opencodeSessions: function () { return []; },
    opencodeModels: function () { return { models: [{ id: 'mock/model-a', providerID: 'mock', modelID: 'model-a', name: 'Mock A', provider: 'Mock' }], selected: 'auto', source: 'mock' }; },
    opencodeSetModel: function (a) { return { selected: a.id }; },
    openAppSettings: function () { return { opened: true }; },
    openTermux: function () { return { opened: true }; },
    agentResume: function () { agentFailure(); return { resumed: true }; },
    providerHealth: function (a) { return providerHealth(a.id); },
    listModels: function (a) {
      return ({ hosted: ['standard-large', 'standard-fast'], compatible: ['custom-default'], local: ['local-small-q4'] })[a.id] || [];
    },
    setSecret: function (a) {
      if (!a.value || String(a.value).length < 8) throw E('INVALID_ARGUMENT', 'That key looks too short.');
      db.secrets[a.id] = true;  // mock: remember presence only, never the value
      save();
      return { stored: true };
    },
    deleteSecret: function (a) { delete db.secrets[a.id]; save(); return { deleted: true }; },
    hasSecret: function (a) { return { exists: !!db.secrets[a.id] }; },
    snapshotCreate: function (a) {
      var s = { id: 's' + Date.now().toString(36), label: a.label || 'Snapshot', at: Date.now(), env: copy(db.env), good: !!a.good };
      db.snapshots.push(s);
      db.snapshots = db.snapshots.slice(-10);
      save();
      return s;
    },
    snapshotList: function () { return db.snapshots.slice().reverse(); },
    snapshotRollback: function (a) {
      var s = db.snapshots.filter(function (x) { return x.id === a.id; })[0];
      if (!s) throw E('NOT_FOUND', 'Snapshot not found.');
      db.env = copy(s.env);
      delete db.chaos.agentSyntax; delete db.chaos.nativeLib;
      save();
      return { restored: s.label };
    },
    repair: function (a) {
      var lv = a.level, c = db.chaos, note = 'Nothing to repair at this level.';
      if (lv === 0) {
        db.netRetries++;
        note = 'Retried the network request.';
        if (c.network && db.netRetries >= 2) { delete c.network; db.netRetries = 0; note = 'Connection restored.'; }
      } else if (lv === 1) { if (c.processKilled) { delete c.processKilled; note = 'Restarted the agent process.'; } }
      else if (lv === 2) { if (c.lowStorage) { delete c.lowStorage; note = 'Cleared 412 MB of disposable cache.'; } else note = 'Cleared temporary state.'; }
      else if (lv === 3) { if (c.nativeLib) { delete c.nativeLib; note = 'Reinstalled the missing native library.'; } }
      else if (lv === 4) { db.env.node = KNOWN_GOOD_NODE; if (c.agentSyntax) { delete c.agentSyntax; } note = 'Switched the runtime to Node ' + KNOWN_GOOD_NODE + ' (known-good).'; }
      save();
      return { level: lv, note: note };
    },
    setBackend: function (a) {
      if (a.name !== 'local' && a.name !== 'remote') throw E('INVALID_ARGUMENT', 'Unknown backend.');
      db.backend = a.name;
      save();
      return a.name === 'remote' ? { backend: 'remote', host: 'dev.example.net', latencyMs: 48 } : { backend: 'local' };
    },
    setChaos: function (a) { if (a.on) db.chaos[a.flag] = true; else delete db.chaos[a.flag]; save(); return { chaos: copy(db.chaos) }; },
    getChaos: function () { return copy(db.chaos); },
    resetDemo: function () { db = freshDb(); save(); return { reset: true }; }
  };

  function handle(method, args, requestId) {
    var latency = 25 + Math.random() * 60;
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          if (!M[method]) throw E('UNKNOWN_METHOD', 'Unknown bridge method: ' + method);
          var data = M[method](args || {});
          resolve({ success: true, data: data, error: null, requestId: requestId });
        } catch (e) {
          resolve({ success: false, data: null, error: { code: e.code || 'UNKNOWN', message: e.message, details: e.details || null }, requestId: requestId });
        }
      }, method === 'runCommand' && /npm\s+t/.test((args || {}).command || '') ? 900 : latency);
    });
  }

  g.MockBackend = { handle: handle, methods: Object.keys(M) };
})(window);
