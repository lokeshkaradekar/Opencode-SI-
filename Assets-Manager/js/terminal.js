/* terminal.js — Terminal controller + screen (Phase 6).
   UI -> Terminal controller -> Bridge -> backend adapter. Potentially destructive
   commands are shown for review before they run; the native side enforces the
   same rule independently (defense in depth). */
(function (g) {
  'use strict';
  var h = UI.h;

  var CAP = 1500;
  var DESTRUCTIVE = /(^|\s)(rm|mv|chmod|chown|dd|kill)\b|git\s+(reset\s+--hard|clean|push\s+.*(--force|-f\b)|checkout\s+--|branch\s+-D|stash\s+drop)|>\s*\S|\|\s*sh\b/;

  var ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
  function stripAnsi(t) { return String(t).replace(ANSI, ''); }
  var nextId = 1;
  var Terminal = {
    lines: [],
    running: false,
    exit: null,
    runId: 0,
    history: Persist.get('cmdhist', []),

    isDestructive: function (cmd) { return DESTRUCTIVE.test(cmd); },

    add: function (t, s) {
      Terminal.lines.push({ id: nextId++, t: t, s: Redact.text(s) });
      while (Terminal.lines.length > CAP) Terminal.lines.shift();
    },
    addBlock: function (t, text) {
      String(text).replace(/\n$/, '').split('\n').forEach(function (l) { Terminal.add(t, l); });
    },
    clear: function () { Terminal.lines = []; Bus.emit('terminal'); },

    /* source: 'user' | 'agent' */
    exec: function (cmd, source) {
      cmd = String(cmd || '').trim();
      if (!cmd) return Promise.resolve();
      if (Terminal.running) { UI.toast('A command is already running. Press Ctrl+C to stop it.'); return Promise.resolve(); }
      if (cmd === 'clear') { Terminal.clear(); return Promise.resolve(); }
      Terminal.history = Terminal.history.filter(function (c) { return c !== cmd; }).concat(cmd).slice(-50);
      Persist.set('cmdhist', Terminal.history);

      var risky = Terminal.isDestructive(cmd);
      var gate = risky
        ? UI.confirm(source === 'agent' ? 'The agent wants to run this' : 'Review before running', cmd + '\n\nThis command can delete or overwrite data.', 'Run command', true)
        : Promise.resolve(true);
      return gate.then(function (ok) {
        Terminal.add('in', '$ ' + cmd);
        if (!ok) { Terminal.add('sys', 'Not run.'); Bus.emit('terminal'); return; }
        return Terminal.run(cmd, risky, source);
      });
    },

    /* One real run. Output is streamed live from the native layer; the final result carries the REAL status
       (SUCCESS | FAILED | CANCELLED | TIMEOUT) and exit code from the daemon's persistent shell. */
    run: function (cmd, confirmed, source) {
      var token = ++Terminal.runId;
      var streamed = false, partial = '';
      Terminal.running = true;
      Terminal.exit = null;
      Terminal.status = 'RUNNING';
      Bus.emit('terminal');
      function onChunk(d) {
        if (token !== Terminal.runId) return;
        streamed = true;
        partial += stripAnsi(d.chunk);
        var parts = partial.split(/\r?\n/);
        partial = parts.pop();
        parts.forEach(function (l) { Terminal.add('out', l.replace(/\r/g, '')); });
        Bus.emit('terminal');
      }
      Bridge.on('terminal', onChunk);
      return Bridge.runCommand(cmd, confirmed).then(function (r) {
        if (token !== Terminal.runId) return;
        if (partial) { Terminal.add('out', partial); partial = ''; }
        if (!streamed && r.stdout) Terminal.addBlock('out', stripAnsi(r.stdout));
        if (r.stderr) Terminal.addBlock('err', r.stderr);
        Terminal.exit = r.exitCode;
        Terminal.status = r.status || (r.exitCode === 0 ? 'SUCCESS' : 'FAILED');
        if (r.status === 'CANCELLED') Terminal.add('sys', 'cancelled');
        else if (r.status === 'TIMEOUT') Terminal.add('sys', 'timed out (exit ' + r.exitCode + ')');
        else if (r.exitCode !== 0) Terminal.add('sys', 'exit ' + r.exitCode);
        if (r.cwd) Terminal.cwd = r.cwd;
      }, function (e) {
        if (token !== Terminal.runId) return;
        if ((e.code === 'CONFIRMATION_REQUIRED' || e.code === 'PERMISSION_CONFIRMATION_REQUIRED') && !confirmed) {
          Terminal.running = false;
          Bus.emit('terminal');
          return UI.confirm('Review before running', cmd + '\n\n' + e.message, 'Run command', true).then(function (ok) {
            if (!ok) { Terminal.add('sys', 'Not run.'); Bus.emit('terminal'); return; }
            return Terminal.run(cmd, true, source);
          });
        }
        var err = Errors.classify({ message: e.message, details: e.details }, e.code);
        Terminal.add('err', e.message);
        if (e.code !== 'COMMAND_NOT_ALLOWED' && e.code !== 'CONFIRMATION_REQUIRED' && e.code !== 'PERMISSION_CONFIRMATION_REQUIRED' && e.code !== 'COMMAND_DENIED') Terminal.add('sys', err.category + ': ' + err.simple);
        Terminal.exit = 1;
        Terminal.status = 'FAILED';
      }).then(function () {
        Bridge.off('terminal', onChunk);
        if (token === Terminal.runId && Terminal.running) {
          Terminal.running = false;
          Bus.emit('terminal');
          if (/^git\s/.test(cmd) || /^(rm|touch|mv|cp|mkdir|npm|pnpm|yarn|node|python3?)\b/.test(cmd)) Bus.emit('files');
        }
      });
    },

    /* Stop: the daemon escalates SIGINT -> SIGTERM -> SIGKILL and the run ends with status CANCELLED. */
    cancel: function () {
      if (!Terminal.running) return;
      Bridge.cancelCommand().then(function () {}, function (e) { Terminal.add('err', 'Could not stop the command: ' + e.message); Bus.emit('terminal'); });
      var t = Terminal.runId;
      setTimeout(function () {   // never leave the UI stuck if the native layer died
        if (Terminal.running && Terminal.runId === t) { Terminal.runId++; Terminal.running = false; Terminal.exit = 130; Terminal.add('sys', 'stopped (no confirmation from the backend)'); Bus.emit('terminal'); }
      }, 12000);
    },

    /* Real Ctrl+C key through the tty. */
    interrupt: function () {
      if (!Terminal.running) return;
      Terminal.add('sys', '^C');
      Bridge.interruptCommand().then(function () {}, function (e) { Terminal.add('err', e.message); Bus.emit('terminal'); });
    },

    /* Real stdin for the running program. */
    sendInput: function (text) {
      Terminal.add('in', text);
      Bus.emit('terminal');
      return Bridge.sendInput(text + '\n').then(function () {}, function (e) { Terminal.add('err', e.message); Bus.emit('terminal'); });
    },

    render: function (el) {
      var out = h('div', { class: 'term-out', role: 'log', 'aria-live': 'off', tabindex: '0' });
      var chip = h('span', { class: 'chip' });
      var input = h('input', { class: 'term-input', type: 'text', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Command' });
      var runBtn = h('button', { class: 'btn primary', onclick: submit }, 'Run');
      var lastId = 0, hIdx = -1, draft = '';

      function lineEl(l) { return h('div', { class: 'tl tl-' + l.t }, l.s || ' '); }

      function sync() {
        var atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
        if (!Terminal.lines.length) { out.innerHTML = ''; }
        else {
          Terminal.lines.forEach(function (l) { if (l.id > lastId) { out.appendChild(lineEl(l)); lastId = l.id; } });
          while (out.childElementCount > Terminal.lines.length) out.removeChild(out.firstChild);
        }
        if (atBottom) out.scrollTop = out.scrollHeight;
        chip.innerHTML = '';
        chip.appendChild(UI.dot(Terminal.running ? 'warning' : (Terminal.exit && Terminal.exit !== 0 ? 'failed' : 'ok')));
        chip.appendChild(document.createTextNode(Terminal.running ? 'running' : Terminal.exit == null ? 'idle' : (Terminal.status && Terminal.status !== 'SUCCESS' && Terminal.status !== 'FAILED' ? Terminal.status.toLowerCase() + ' · ' : '') + 'exit ' + Terminal.exit));
        runBtn.textContent = Terminal.running ? (input.value ? 'Send' : 'Stop') : 'Run';
        runBtn.classList.toggle('danger', Terminal.running);
      }

      function submit() {
        if (Terminal.running) {
          if (input.value) { var t = input.value; input.value = ''; Terminal.sendInput(t); } else Terminal.cancel();
          return;
        }
        var c = input.value;
        input.value = ''; hIdx = -1;
        Terminal.exec(c, 'user');
      }
      function histMove(d) {
        if (!Terminal.history.length) return;
        if (hIdx === -1) { draft = input.value; hIdx = Terminal.history.length; }
        hIdx = Math.max(0, Math.min(Terminal.history.length, hIdx + d));
        input.value = hIdx === Terminal.history.length ? draft : Terminal.history[hIdx];
      }

      input.addEventListener('input', sync);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); histMove(-1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); histMove(1); }
        else if (e.ctrlKey && e.key.toLowerCase() === 'c' && (Terminal.running || input.selectionStart === input.selectionEnd)) { e.preventDefault(); Terminal.interrupt(); }
        else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); Terminal.clear(); }
      });

      function quick(label, fn, aria) { return h('button', { class: 'key', onclick: fn, 'aria-label': aria || label }, label); }
      var keys = h('div', { class: 'keys' },
        quick('Ctrl+C', function () { Terminal.interrupt(); }, 'Send Ctrl+C to the running command'),
        quick('\u2191', function () { histMove(-1); input.focus(); }, 'Previous command'),
        quick('\u2193', function () { histMove(1); input.focus(); }, 'Next command'),
        quick('ls', function () { Terminal.exec('ls', 'user'); }),
        quick('git status', function () { Terminal.exec('git status', 'user'); }),
        quick('npm test', function () { Terminal.exec('npm test', 'user'); }),
        quick('help', function () { Terminal.exec('help', 'user'); }));

      if (!Terminal.lines.length) { Terminal.add('sys', 'Commands run in the project folder. Type help for the allowed list.'); }

      el.appendChild(h('div', { class: 'term' },
        h('div', { class: 'term-bar' }, chip,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small ghost', onclick: function () { UI.copy(Terminal.lines.map(function (l) { return l.s; }).join('\n')); } }, 'Copy output'),
          h('button', { class: 'btn small ghost', onclick: function () { Terminal.clear(); } }, 'Clear')),
        out, keys,
        h('div', { class: 'term-row' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '$'), input, runBtn)));
      sync();
      out.scrollTop = out.scrollHeight;

      var resizeTimer = null, ro = null;
      if (window.ResizeObserver) {
        ro = new ResizeObserver(function () {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            var cols = Math.max(20, Math.floor(out.clientWidth / 7.8)), rows = Math.max(5, Math.floor(out.clientHeight / 18));
            Bridge.resizeTerminal(cols, rows).then(function () {}, function () {});
          }, 200);
        });
        ro.observe(out);
      }
      var off = Bus.on('terminal', sync);
      return function () { off(); clearTimeout(resizeTimer); if (ro) ro.disconnect(); };
    }
  };

  g.Terminal = Terminal;
})(window);
