/* health.js — Health Engine, Recovery Engine (levels 0–7), snapshots/rollback,
   remote fallback, and the Health screen.
   Reliability loop: Detect → Diagnose → Repair → Verify → Fallback → Resume.
   Rules: least destructive first; risky levels need confirmation; a snapshot is
   taken before anything that changes the environment; project files are never touched. */
(function (g) {
  'use strict';
  var h = UI.h;

  var STAGES = [
    { id: 'detect', label: 'Detect' }, { id: 'diagnose', label: 'Diagnose' }, { id: 'repair', label: 'Repair' },
    { id: 'verify', label: 'Verify' }, { id: 'fallback', label: 'Fallback' }, { id: 'resume', label: 'Resume' }
  ];

  var LEVELS = {
    0: { label: 'Retry' },
    1: { label: 'Restart process' },
    2: { label: 'Clear temporary state' },
    3: { label: 'Repair dependency', confirm: 'Not available in this build; the step will report that and the next level is tried.' },
    4: { label: 'Switch to known-good runtime', confirm: 'Not available in this build; the step will report that and the next level is tried.' },
    5: { label: 'Restore project files from the last known-good snapshot', confirm: 'This puts your PROJECT FILES back to the last snapshot taken after a passing health check. Changes made since then are undone (a safety snapshot is taken first so this can be reversed).' },
    6: { label: 'Use remote workspace' },
    7: { label: 'Manual diagnosis' }
  };

  // Which levels are tried (in order) for each category. Level 6 is offered, never automatic.
  var PLAN = {
    RUNTIME: [1, 2, 4, 5], NATIVE: [2, 3, 5], STORAGE: [2], PROCESS: [1, 2], NETWORK: [0, 0, 0],
    TERMINAL: [1], PACKAGE: [2, 3, 5], OS: [], UNKNOWN: [1, 2, 5]
  };

  var CHAOS = [
    ['agentSyntax', 'Break the agent runtime'],
    ['nativeLib', 'Remove a native library'],
    ['lowStorage', 'Fill device storage'],
    ['processKilled', 'Kill the agent process'],
    ['network', 'Cut the network'],
    ['providerOutage', 'Hosted provider outage']
  ];

  var Health = {
    busy: false,
    STAGES: STAGES,
    LEVELS: LEVELS,

    problems: function () { return State.health.checks.filter(function (c) { return c.status !== 'ok'; }); },

    run: function (opts) {
      opts = opts || {};
      if (!opts.silent) State.set({ loop: { stage: 'detect', log: [] } });
      var env;
      return Bridge.healthCheck().then(function (r) {
        env = r;
        var checks = env.checks.slice();
        var status = checks.some(function (c) { return c.status === 'failed'; }) ? 'failed' : checks.some(function (c) { return c.status === 'warning'; }) ? 'warning' : 'ok';
        var health = { status: status, checks: checks, at: Date.now() };
        State.set({ health: health });
        if (!opts.silent) {
          var n = checks.filter(function (c) { return c.status !== 'ok'; }).length;
          State.set({ loop: n ? { stage: 'diagnose', log: ['Found ' + n + ' problem' + (n > 1 ? 's' : '') + '. Your project files are safe.'] } : { stage: null, log: [] } });
        }
        return health;
      }, function (e) {
        var health = { status: 'failed', at: Date.now(), checks: [{ key: 'bridge', name: 'Bridge', status: 'failed', detail: e.message, raw: e.details || e.message }] };
        State.set({ health: health });
        return health;
      });
    },

    /* Detect → Diagnose → Repair → Verify → (Fallback | Resume) for one failing check. */
    recover: function (check) {
      if (Health.busy) return Promise.resolve({ fixed: false, busy: true });
      Health.busy = true;
      var log = [];
      var say = function (s) { log.push(s); State.set({ loop: { stage: State.loop.stage, log: log.slice() } }); };
      var stage = function (s) { State.set({ loop: { stage: s, log: log.slice() } }); };
      var stillBroken = function (hl) { return hl.checks.some(function (c) { return c.key === check.key && c.status !== 'ok'; }); };

      function finish(fixed) {
        Health.busy = false;
        if (fixed) {
          stage('resume'); say('Ready to resume.');
          return Bridge.snapshotCreate('Verified after repair', true).then(function () { return { fixed: true }; }, function () { return { fixed: true }; });
        }
        stage('fallback');
        say('Local repair did not fix it. Your project is safe \u2014 you can use a remote workspace.');
        return Promise.resolve({ fixed: false });
      }

      stage('diagnose');
      var err = Errors.classify(check.raw || check.detail || '');
      say('Diagnosed: ' + err.category + ' \u2014 ' + err.title);

      // The OpenCode server is repaired by (re)starting it through Termux, never by touching project files.
      if (check.key === 'opencode_server') {
        stage('repair'); say('Starting the OpenCode server\u2026');
        return OpenCode.ensure(true).then(function (st) {
          say(st.message || 'OpenCode status checked.');
          // A successful /global/health probe can coexist with a wedged app-managed server. If the
          // first recovery did not make it READY, restart only the server this app owns and only when
          // it reports no active tasks. Never kill a foreign/manual OpenCode process.
          if (st.state !== 'READY' && st.managed && !(st.activeTasks > 0)) {
            stage('repair'); say('The managed server is still not ready. Restarting the server owned by OpenCode SI…');
            return Bridge.opencodeStop(true).then(function () { return OpenCode.ensure(true); }).then(function (next) {
              say(next.message || 'OpenCode restart finished.');
              return next;
            });
          }
          return st;
        }).then(function (st) {
          if (st && st.message) say(st.message);
          stage('verify');
          return Health.run({ silent: true }).then(function (hl) { return finish(!stillBroken(hl)); });
        }).catch(function (e) { say(e && e.message ? e.message : 'OpenCode repair failed.'); return finish(false); });
      }

      var plan = (PLAN[err.category] || PLAN.UNKNOWN).slice();
      if (!plan.length) { say('No automatic repair exists for this. Manual diagnosis needed.'); return finish(false); }

      function snapshotBefore(lv) {
        return (lv >= 3 && lv <= 4) ? Bridge.snapshotCreate('Before: ' + LEVELS[lv].label, false).then(function () { say('Snapshot saved.'); }) : Promise.resolve();
      }
      function apply(lv) {
        if (lv !== 5) return Bridge.repair(lv).then(function (r) { say(r.note); });
        return Bridge.snapshotList().then(function (list) {
          var good = list.filter(function (s) { return s.good; })[0];
          if (!good) throw new Error('No known-good snapshot exists.');
          return Bridge.snapshotRollback(good.id, true).then(function () { say('Restored: ' + good.label); });
        });
      }

      function next() {
        if (!plan.length) return finish(false);
        var lv = plan.shift(), L = LEVELS[lv];
        var gate = L.confirm ? UI.confirm('Level ' + lv + ': ' + L.label, L.confirm, 'Continue') : Promise.resolve(true);
        return gate.then(function (ok) {
          if (!ok) { say('Skipped: ' + L.label); return next(); }
          stage('repair'); say('Level ' + lv + ': ' + L.label + '\u2026');
          return snapshotBefore(lv).then(function () { return apply(lv); }).then(function () {
            stage('verify');
            return Health.run({ silent: true });
          }).then(function (hl) {
            if (!stillBroken(hl)) { say('\u2713 Verified: ' + check.name + ' is healthy.'); return finish(true); }
            say('Still failing. Trying the next safe step.');
            return next();
          }, function (e) { say('Step failed: ' + e.message); return next(); });
        });
      }
      return next().catch(function () { return finish(false); });
    },

    useRemote: function () {
      return Bridge.setBackend('remote').catch(function (e) { UI.toast(e.message, 'bad'); throw e; }).then(function (r) {
        State.set({ backend: 'remote' });
        return Health.run({ silent: true }).then(function () {
          State.set({ loop: { stage: 'resume', log: ['Switched to remote workspace ' + (r.host || '') + ' (' + (r.latencyMs || '?') + ' ms).', 'Project is available. Ready to resume.'] } });
        });
      });
    },
    useLocal: function () {
      return Bridge.setBackend('local').then(function () {
        State.set({ backend: 'local' });
        return Health.run();
      });
    }
  };

  /* ---------- screen ---------- */
  // Icon per real check key. Two layers feed State.health.checks, merged by NativeBridge.healthCheck():
  // Java-native checks (bridge, termux_app, permission, daemon, auth, daemon_health, storage_app, opencode_server)
  // run first, then the daemon's own checks (daemon/ocd.py `health()`) are appended as-is, except its own
  // "termux" key is renamed to "termux_env" to avoid colliding with the Java "termux_app"/"daemon" checks.
  var CHECK_ICON = {
    bridge: 'link', termux_app: 'android', permission: 'key', daemon: 'terminal', auth: 'key',
    daemon_health: 'shield', storage_app: 'disk', opencode_server: 'shield',
    termux_env: 'termgear', os: 'android', arch: 'cpu', node: 'termgear', npm: 'termgear', python: 'termgear',
    git: 'git', shell: 'terminal', pty: 'terminal', workspace: 'folder', storage: 'disk', process: 'gear',
    git_ops: 'git', network: 'wifi'
  };

  function strip() {
    var cur = STAGES.map(function (s) { return s.id; }).indexOf(State.loop.stage);
    return h('ol', { class: 'loop', 'aria-label': 'Reliability loop' }, STAGES.map(function (s, i) {
      var cls = 'seg';
      if (cur >= 0) {
        if (i < cur) cls += ' done';
        else if (i === cur) cls += s.id === 'fallback' ? ' now bad' : ' now';
      }
      var circleState = cur < 0 ? '' : (i < cur ? 'done' : i === cur ? (s.id === 'fallback' ? 'now bad' : 'now') : '');
      return h('li', { class: cls },
        h('span', { class: 'seg-circle ' + circleState }, i < cur ? '\u2713' : String(i + 1)),
        h('span', { class: 'seg-label' }, s.label));
    }));
  }

  function checkRow(c) {
    var row = h('li', { class: 'check ' + c.status },
      h('span', { class: 'check-ico ' + c.status }, UI.icon(CHECK_ICON[c.key] || 'health', 18)),
      h('div', { class: 'check-body' },
        h('span', { class: 'check-name' }, c.name),
        h('span', { class: 'check-detail' }, c.detail || '')
      ),
      h('span', { class: 'check-status ' + c.status }, UI.dot(c.status), c.status === 'ok' ? 'OK' : c.status === 'warning' ? 'Warning' : 'Failed')
    );
    if (c.status !== 'ok') {
      row.appendChild(h('button', {
        class: 'btn small primary', disabled: Health.busy,
        onclick: function () { Health.recover(c).then(function (r) { if (r.fixed) UI.toast('Fixed: ' + c.name); }); }
      }, 'Repair'));
      var err = Errors.classify(c.raw || c.detail || '');
      var wrap = h('li', { class: 'check-err' }, UI.errorCard(err, []));
      return [row, wrap];
    }
    return row;
  }

  var chaosOpen = false;

  function render(el) {
    var chaosBox = h('div', { class: 'chaos' });
    function draw() {
      var hl = State.health, probs = Health.problems();
      var remote = State.backend === 'remote';
      el.innerHTML = '';
      var top = h('section', { class: 'panel health-hero' },
        h('div', { class: 'health-hero-top' },
          h('div', { class: 'pulse-icon ' + hl.status }, UI.icon('pulse', 24)),
          h('div', { class: 'health-hero-text' },
            h('div', { class: 'health-hero-title' }, hl.status === 'ok' ? 'Everything is working' : hl.status === 'unknown' ? 'Not checked yet' : probs.length + ' problem' + (probs.length === 1 ? '' : 's') + ' found'),
            h('div', { class: 'health-hero-sub' }, UI.icon('refresh', 12), (remote ? 'Remote workspace' : 'Local (Termux)') + (hl.at ? ' \u00b7 checked ' + UI.timeAgo(hl.at) : ' \u00b7 not checked yet'))
          ),
          h('button', { class: 'btn run-checks-btn', disabled: Health.busy, onclick: function () { Health.run(); } }, UI.icon('refresh', 14), 'Run checks')
        ),
        strip(),
        State.loop.log.length ? h('ul', { class: 'loop-log' }, State.loop.log.map(function (l) { return h('li', null, l); })) : null
      );
      el.appendChild(top);

      // One entry point for the complete, real setup/repair wizard. This deliberately
      // routes through the existing Termux checks so blocked RUN_COMMAND is explained
      // instead of being reported as an automatic success.
      if (!remote && (probs.length || hl.status === 'unknown')) {
        el.appendChild(h('section', { class: 'panel health-auto-repair' },
          h('div', { class: 'health-auto-repair-copy' },
            h('h3', { class: 'h3' }, 'Auto Setup & Repair'),
            h('p', { class: 'muted' }, 'Diagnose Termux, storage access, the daemon and OpenCode. SI repairs what it can, verifies each step, and guides you through any Android or Termux permission that must be approved manually. Your project files are not deleted.')
          ),
          h('button', { class: 'btn primary', onclick: function () {
            if (typeof OpenCode !== 'undefined' && OpenCode.setupSheet) OpenCode.setupSheet();
            else UI.toast('Setup wizard is not available in this build.', 'bad');
          } }, 'Auto Setup & Repair')
        ));
      }

      if (State.loop.stage === 'fallback' || (remote && State.loop.stage === 'resume')) {
        el.appendChild(h('section', { class: 'panel fallback' },
          remote
            ? [h('h3', { class: 'h3' }, 'Using the remote workspace'), h('p', { class: 'muted' }, 'Commands and the agent run on your server. Your project is the same.'),
              h('button', { class: 'btn', onclick: function () { Health.useLocal(); } }, 'Switch back to local')]
            : [h('h3', { class: 'h3' }, 'Local environment is unhealthy'), h('p', { class: 'muted' }, 'Your project is safe. You can keep trying to repair it or continue on a remote workspace.'),
              h('div', { class: 'row' },
                h('button', { class: 'btn', onclick: function () { Health.run(); } }, 'Repair locally'),
                h('button', { class: 'btn primary', onclick: function () { Health.useRemote(); } }, 'Use remote workspace'))]
        ));
      } else if (!remote && probs.length) {
        el.appendChild(h('div', { class: 'row inline-actions' },
          h('button', { class: 'btn ghost small', onclick: function () { Health.useRemote(); } }, 'Use remote workspace instead')));
      }

      el.appendChild(h('ul', { class: 'checks panel' }, hl.checks.map(checkRow)));

      var snaps = h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Snapshots'), h('p', { class: 'muted' }, 'Taken before any environment change. Secrets are never stored in them.'));
      el.appendChild(snaps);
      Bridge.snapshotList().then(function (list) {
        snaps.appendChild(h('ul', { class: 'plain' }, list.slice(0, 4).map(function (s) {
          return h('li', { class: 'snap' }, UI.dot(s.good ? 'ok' : 'unknown'), h('span', null, s.label), h('span', { class: 'muted' }, UI.timeAgo(s.at)));
        })));
      }, function () { /* ignore */ });

      if (Bridge.mode === 'mock') {
        chaosBox.innerHTML = '';
        el.appendChild(h('details', { class: 'panel chaos-wrap', open: chaosOpen, ontoggle: function (e) { chaosOpen = e.target.open; } },
          h('summary', null, 'Break things (test recovery)'),
          h('p', { class: 'muted' }, 'Prototype only. Each switch simulates a real failure, then use Repair.'),
          chaosBox,
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn small', onclick: function () { Agent.simulateKill(); UI.toast('Simulated: Android killed the app'); } }, 'Kill app mid-task'),
            h('button', { class: 'btn small', onclick: function () { location.reload(); } }, 'Reload app'),
            h('button', { class: 'btn small danger', onclick: function () { UI.confirm('Reset demo data?', 'Projects, files, chat and settings in this prototype return to their starting state.', 'Reset', true).then(function (ok) { if (ok) Bridge.resetDemo().then(function () { Persist.clearAll(); location.reload(); }); }); } }, 'Reset demo')
          )
        ));
        Bridge.getChaos().then(function (state) {
          CHAOS.forEach(function (c) {
            var cb = h('input', { type: 'checkbox', checked: !!state[c[0]], onchange: function () { Bridge.setChaos(c[0], cb.checked).then(function () { Health.run(); }); } });
            chaosBox.appendChild(h('label', { class: 'switch' }, cb, h('span', null, c[1])));
          });
        });
      }
    }
    draw();
    var off = Bus.on('state', function (p) { if (p.health || p.loop || p.backend) draw(); });
    return off;
  }

  Health.render = render;
  g.Health = Health;
})(window);
