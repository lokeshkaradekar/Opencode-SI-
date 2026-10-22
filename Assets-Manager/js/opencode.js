/* opencode.js — state, status indicator, setup wizard, diagnostics, workspace and model settings for the OFFICIAL
   OpenCode server that the app starts and manages through Termux.
   Every state shown here comes from NativeBridge (a real health probe or a real Termux result). Nothing is scripted. */
(function (g) {
  'use strict';
  var h = UI.h;

  var LABEL = {
    CHECKING_TERMUX: ['Connecting', 'warning'], CHECKING_SERVER: ['Connecting', 'warning'],
    STARTING_SERVER: ['Starting OpenCode', 'warning'], WAITING_FOR_HEALTH: ['Starting OpenCode', 'warning'],
    RESTARTING: ['Reconnecting', 'warning'], STOPPING: ['Stopping', 'warning'],
    READY: ['Ready', 'ok'], SERVER_STOPPED: ['Connection lost', 'failed'],
    NOT_CONFIGURED: ['Setup required', 'failed'], AUTHENTICATION_FAILED: ['Authentication required', 'failed'],
    CONNECTION_FAILED: ['Startup failed', 'failed']
  };

  var OpenCode = {
    status: { state: 'CHECKING_SERVER', message: 'Not checked yet.', code: null, detail: null, managed: false, workspace: null, port: 4096, version: null, authEnforced: null, workspaceVerified: false, activeTasks: 0 },
    models: null,
    selectedModel: 'auto',
    started: false,
    monitorTimer: null,
    monitorInFlight: false,
    monitorManaged: false,

    label: function () { return (LABEL[OpenCode.status.state] || ['Unknown', 'unknown'])[0]; },
    tone: function () { return (LABEL[OpenCode.status.state] || ['Unknown', 'unknown'])[1]; },
    ready: function () { return OpenCode.status.state === 'READY'; },
    needsSetup: function () { return OpenCode.status.state === 'NOT_CONFIGURED'; },

    // Derive setup state from live probes, never from a one-time dismissed flag.
    setupCompletion: function (checks) {
      var required = ['termux_app', 'run_command_permission', 'external_apps', 'workspace_access', 'opencode_found', 'opencode_runs', 'server_running', 'server_health', 'test_session'];
      var map = {};
      (checks || []).forEach(function (c) { if (c && c.key) map[c.key] = c; });
      var missing = required.filter(function (key) { return !map[key] || map[key].status !== 'ok'; });
      return { complete: missing.length === 0, missing: missing, checks: map };
    },

    checkSetupCompletion: function () {
      return Bridge.opencodeSetupChecks().then(function (checks) {
        return { checks: checks || [], result: OpenCode.setupCompletion(checks || []) };
      });
    },

    set: function (st) {
      if (!st || !st.state) return;
      OpenCode.status = st;
      if (st.managed === true) OpenCode.monitorManaged = true;
      // Clear ownership only when a definitive status says the server is foreign/stopped or setup is gone.
      // A transient startup failure often reports managed=false even though SI previously owned the server.
      if (st.managed === false && (st.state === 'READY' || st.state === 'SERVER_STOPPED' || st.state === 'NOT_CONFIGURED' || st.state === 'AUTHENTICATION_FAILED')) OpenCode.monitorManaged = false;
      Bus.emit('opencode', st);
    },

    /* Real check + start through Termux if needed. Safe to call repeatedly: the native side joins an in-flight start. */
    ensure: function (force) {
      return Bridge.opencodeEnsure(force).then(function (st) { OpenCode.set(st); return st; }, function (e) {
        var st = { state: 'CONNECTION_FAILED', code: e.code, message: e.message, detail: e.details || null, managed: false, port: OpenCode.status.port, activeTasks: 0 };
        OpenCode.set(st);
        return st;
      });
    },

    refresh: function () {
      return Bridge.opencodeStatus().then(function (st) { OpenCode.set(st); return st; }, function () { return OpenCode.status; });
    },

    /* Called once at app start (native only). */
    start: function () {
      if (OpenCode.started || Bridge.mode === 'none') return Promise.resolve(OpenCode.status);
      OpenCode.started = true;
      Bridge.on('opencode.state', function (st) { OpenCode.set(st); });
      Bridge.on('permission', function (p) { if (p && p.granted) OpenCode.ensure(true); else OpenCode.refresh(); });
      Bridge.on('workspace.picked', function (p) {
        if (p.error) { UI.toast(p.error, 'bad'); return; }
        Bridge.opencodeSetWorkspace('custom', p.path).then(function () { UI.toast('Folder set. Applying\u2026'); return OpenCode.ensure(true); }, function (e) { UI.toast(e.message, 'bad'); });
      });
      Bridge.opencodeModels().then(function (m) { OpenCode.models = m.models; OpenCode.selectedModel = m.selected || 'auto'; Bus.emit('opencode'); }, function () {});
      // A managed Termux server can die or become unreachable while the app remains open.
      // Poll a real health probe while the WebView is alive; never restart on one slow request,
      // never take over a foreign server, and never interrupt a tracked agent task.
      if (typeof setInterval === 'function' && !OpenCode.monitorTimer) {
        OpenCode.monitorTimer = setInterval(function () { OpenCode.monitorNow(); }, 25000);
      }
      return OpenCode.refresh().then(function () { return OpenCode.ensure(false); }).then(function (st) {
        // Startup must recover a stopped server. The old code repeated ensure(false),
        // which only probes and never launches OpenCode; Health > Repair used ensure(true),
        // so the app could appear broken until the user pressed Repair manually.
        if (st.state === 'SERVER_STOPPED' || st.state === 'RESTARTING' || st.state === 'STARTING_SERVER' || st.state === 'WAITING_FOR_HEALTH') {
          return OpenCode.ensure(true);
        }
        return st;
      });
    },

    monitorNow: function () {
      if (!OpenCode.started || OpenCode.monitorInFlight || Bridge.mode !== 'native') return Promise.resolve(OpenCode.status);
      var before = OpenCode.status;
      // Ownership is remembered across transient startup errors, whose status payload may have managed=false.
      // A user-managed server is never taken over, and active tasks are never interrupted by the monitor.
      if (!before || !OpenCode.monitorManaged || before.activeTasks > 0) return Promise.resolve(before);
      OpenCode.monitorInFlight = true;
      var check;
      if (before.state === 'CONNECTION_FAILED' || before.state === 'SERVER_STOPPED') {
        // A previous recovery may have failed after the server was known to be managed. Re-probe and make
        // one ordinary non-forced ensure attempt; native cool-down and single-flight guards still apply.
        check = Bridge.opencodeEnsure(false);
      } else {
        check = Bridge.opencodeRecheck();
      }
      return check.then(function (st) {
        OpenCode.set(st);
        // If a real recheck confirms the server is down, request normal recovery.
        if (st && st.state === 'SERVER_STOPPED' && st.managed && !(st.activeTasks > 0)) {
          return OpenCode.ensure(false);
        }
        return st;
      }, function () { return OpenCode.status; }).then(function (st) {
        OpenCode.monitorInFlight = false;
        return st;
      }, function () {
        OpenCode.monitorInFlight = false;
        return OpenCode.status;
      });
    },

    onResume: function () {
      if (!OpenCode.started) return;
      // Native also rechecks on resume. Follow with a bounded JS-side recovery pass.
      OpenCode.monitorNow();
      setTimeout(function () { OpenCode.monitorNow(); }, 1500);
    },

    stop: function () {
      var st = OpenCode.status;
      var busy = st.activeTasks > 0;
      return UI.confirm('Stop the OpenCode server?', busy ? 'A task is still running. Stopping the server will interrupt it.' : 'Only the server this app started is stopped. It starts again next time you open the app.', 'Stop server', true).then(function (ok) {
        if (!ok) return;
        return Bridge.opencodeStop(busy).then(function (s) { OpenCode.set(s); UI.toast('Server stopped'); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    },

    /* ---------- compact indicator ---------- */
    chip: function () {
      return h('button', { class: 'chip chip-btn', 'aria-label': 'OpenCode: ' + OpenCode.label(), onclick: OpenCode.openSheet }, UI.dot(OpenCode.tone()), 'OpenCode \u00b7 ' + OpenCode.label());
    },

    /* ---------- status sheet ---------- */
    openSheet: function () {
      var st = OpenCode.status;
      var body = h('div', { class: 'oc-sheet' });
      function row(k, v) { return v == null || v === '' ? null : h('p', { class: 'muted' }, h('strong', null, k + ': '), String(v)); }
      body.appendChild(h('p', null, UI.dot(OpenCode.tone()), ' ', h('strong', null, OpenCode.label()), ' \u2014 ', st.message || ''));
      body.appendChild(row('Details', st.detail && Redact.text(st.detail)));
      body.appendChild(row('Folder', st.workspace));
      body.appendChild(row('Server', '127.0.0.1:' + st.port + (st.version ? ' \u00b7 ' + st.version : '') + (st.managed ? ' \u00b7 started by this app' : (st.state === 'READY' ? ' \u00b7 started elsewhere' : ''))));
      if (st.state === 'READY' && st.authEnforced === false) body.appendChild(h('p', { class: 'muted' }, 'Security: this server answers without a password. Other apps on this phone could use it.'));
      if (st.state === 'READY' && st.workspaceVerified === false) body.appendChild(h('p', { class: 'muted' }, 'The server did not confirm which folder it works in.'));
      body.appendChild(h('div', { class: 'row oc-agent-actions' },
        h('button', { class: 'btn primary', onclick: function () { sheet.close(); OpenCode.ensure(true); } }, st.state === 'READY' ? 'Re-check' : 'Start / retry'),
        st.code === 'WORKSPACE_MISMATCH' ? h('button', { class: 'btn primary', onclick: function () {
          sheet.close();
          var observed = st.detail || 'an unverified folder';
          var wanted = st.workspace || 'the selected project';
          UI.confirm('Switch Project & Repair', 'The OpenCode server currently works in ' + observed + ', but the selected project is ' + wanted + '. SI will first check that no task is tracked as running in this app, then stop only a uniquely identified OpenCode process whose command, port, and OS working directory match. If verification fails, it will leave the process untouched. Continue?', 'Switch & repair', true).then(function (ok) {
            if (!ok) return;
            UI.toast('Verifying server and project…');
            Bridge.opencodeSwitchRepair(true).then(function (next) {
              OpenCode.set(next);
              if (next.state === 'READY' && next.workspaceVerified) UI.toast('Project switched and OpenCode verified.');
              else UI.toast(next.message || 'Project switch could not be verified.', 'bad');
              OpenCode.openSheet();
            }, function (e) { UI.toast(e.message || 'Project repair failed.', 'bad'); OpenCode.refresh(); });
          });
        } }, 'Switch Project & Repair') : null,
        st.managed && st.state === 'READY' ? h('button', { class: 'btn stop-server-action', onclick: function () { sheet.close(); OpenCode.stop(); } }, 'Stop server') : null,
        h('button', { class: 'btn', onclick: function () { sheet.close(); OpenCode.setupSheet(); } }, 'Setup check')));
      var diag = h('details', { class: 'oc-diag' }, h('summary', null, 'Diagnostics'), h('pre', { class: 'code' }, 'Loading\u2026'));
      diag.addEventListener('toggle', function () {
        if (!diag.open) return;
        Bridge.opencodeDiagnostics().then(function (d) { diag.querySelector('pre').textContent = Redact.text(d.lines.join('\n')) || '(nothing recorded yet)'; }, function (e) { diag.querySelector('pre').textContent = e.message; });
      });
      body.appendChild(diag);
      var sheet = UI.sheet({ title: 'OpenCode server', body: body });
    },

    /* ---------- first-run / setup wizard (real probes) ---------- */
    setupSheet: function () {
      var checksBox = h('div', { class: 'checks', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Checking Termux and OpenCode…'));
      var statusBox = h('div', { class: 'setup-live-status', 'aria-live': 'polite' },
        h('div', { class: 'setup-spinner' }),
        h('div', null, h('strong', null, 'Checking your setup'), h('p', { class: 'muted' }, 'The first check starts immediately. No success is assumed until the real checks return.')));
      var progressTrack = h('div', { class: 'setup-progress-track', hidden: true }, h('div', { class: 'setup-progress-fill' }));
      var progressLabel = h('p', { class: 'setup-progress-label muted', hidden: true }, 'Waiting for setup…');
      var logDetails = h('details', { class: 'oc-diag' }, h('summary', null, 'Technical details and installer log'), h('pre', { class: 'setup-log' }, 'No installer log yet.'));
      var actions = h('div', { class: 'row wrap setup-actions' });
      var body = h('div', { class: 'oc-setup-wizard' },
        h('p', { class: 'muted' }, 'Follow the steps in order. OpenCode SI checks the real environment, installs missing tools in Termux, downloads and verifies the OpenCode runtime, then tests the server. Download progress and errors come from the installer—not a fake timer.'),
        h('div', { class: 'setup-steps' },
          h('div', { class: 'setup-step' }, h('span', { class: 'setup-step-number' }, '1'), h('div', null, h('strong', null, 'Install and open Termux'), h('p', { class: 'muted' }, 'Termux must be installed and opened once before setup.'))),
          h('div', { class: 'setup-step' }, h('span', { class: 'setup-step-number' }, '2'), h('div', null, h('strong', null, 'Allow OpenCode SI to run commands'), h('p', { class: 'muted' }, 'Grant Android permission and enable Termux external commands. This is a one-time Android/Termux security requirement.'))),
          h('div', { class: 'setup-step' }, h('span', { class: 'setup-step-number' }, '3'), h('div', null, h('strong', null, 'Install dependencies and OpenCode'), h('p', { class: 'muted' }, 'The app installs Python, Git, Node.js and downloads the pinned Android/Termux OpenCode runtime.'))),
          h('div', { class: 'setup-step' }, h('span', { class: 'setup-step-number' }, '4'), h('div', null, h('strong', null, 'Start and verify services'), h('p', { class: 'muted' }, 'The daemon and OpenCode server are checked before setup is marked complete.')))),
        statusBox, progressTrack, progressLabel, checksBox, actions, logDetails);
      var pollTimer = null, pollBusy = false, installStarted = false, closed = false, latestChecks = [], pollFailures = 0;
      var sheet = UI.sheet({ title: 'Set up OpenCode SI', body: body, onClose: function () { closed = true; if (pollTimer) clearTimeout(pollTimer); } });
      // A blocked RUN_COMMAND cannot enable itself. This is the smallest supported
      // one-time recovery command; it updates an existing setting instead of adding
      // duplicate keys, then asks Termux/Android to grant shared-storage access.
      // Only edit the Termux property here. Running termux-setup-storage every time
      // caused repeated confirmation prompts and distracted from the required app restart.
      // This command is intentionally run by the user inside Termux because RUN_COMMAND
      // cannot bootstrap itself while allow-external-apps is disabled.
      var externalCommand = "set -eu\nmkdir -p \"$HOME/.termux\"\nf=\"$HOME/.termux/termux.properties\"\ntouch \"$f\"\nif grep -Eq '^[[:space:]]*allow-external-apps[[:space:]]*=' \"$f\"; then\n  sed -i 's/^[[:space:]]*allow-external-apps[[:space:]]*=.*/allow-external-apps = true/' \"$f\"\nelse\n  printf '\\nallow-external-apps = true\\n' >> \"$f\"\nfi\nprintf '\\nSaved setting: '\ngrep -E '^[[:space:]]*allow-external-apps[[:space:]]*=' \"$f\"";

      function setStatus(title, detail, tone, spinner) {
        statusBox.innerHTML = '';
        if (spinner) statusBox.appendChild(h('div', { class: 'setup-spinner' }));
        statusBox.appendChild(h('div', null, h('strong', null, title), h('p', { class: tone ? 'setup-tone-' + tone : 'muted' }, detail || '')));
      }
      function setActions(items) {
        actions.innerHTML = '';
        items.forEach(function (it) {
          actions.appendChild(h('button', { class: 'btn ' + (it.kind || ''), disabled: !!it.disabled, onclick: function () { try { it.run(); } catch (e) { setStatus('Action failed', e.message || String(e), 'bad', false); } } }, it.label));
        });
      }
      function addAction(items, label, kind, fn) { items.push({ label: label, kind: kind, run: fn }); }
      function renderChecks(checks) {
        latestChecks = checks || [];
        checksBox.innerHTML = '';
        if (!latestChecks.length) { checksBox.appendChild(h('p', { class: 'muted' }, 'No check results were returned.')); return; }
        latestChecks.forEach(function (c) {
          checksBox.appendChild(h('div', { class: 'check' },
            h('span', { class: 'check-ico ' + (c.status || 'unknown') }, UI.dot(c.status === 'ok' ? 'ok' : c.status === 'warning' ? 'warning' : c.status === 'failed' ? 'failed' : 'unknown')),
            h('span', { class: 'check-body' }, h('span', { class: 'check-name' }, c.name || c.key), h('span', { class: 'check-detail' }, c.detail || 'No detail returned.')),
            h('span', { class: 'check-status ' + (c.status || 'unknown') }, c.status === 'ok' ? 'OK' : c.status === 'warning' ? 'Check' : c.status === 'failed' ? 'Fix' : 'Unknown')));
        });
      }
      function checkMap() { var m = {}; latestChecks.forEach(function (c) { m[c.key] = c; }); return m; }
      function refreshChecks() {
        setStatus('Checking your setup', 'Checking Termux, Android permission, daemon files, OpenCode executable and server response.', 'muted', true);
        setActions([{ label: 'Checking…', kind: 'primary', disabled: true, run: function () {} }]);
        Bridge.opencodeSetupChecks().then(function (checks) {
          renderChecks(checks);
          Bus.emit('setup.checks', checks || []);
          var m = checkMap(), items = [];
          if (m.termux_app && m.termux_app.status === 'failed') {
            setStatus('Termux is missing', 'Install Termux from F-Droid, open it once, then return to this screen. The current local backend cannot run without Termux.', 'bad', false);
            addAction(items, 'Install Termux', 'primary', function () { Bridge.openSupportLink('termux').catch(function (e) { setStatus('Could not open Termux download page', e.message, 'bad', false); }); });
            addAction(items, 'Check again', 'ghost', refreshChecks);
          } else if (m.run_command_permission && m.run_command_permission.status === 'failed') {
            setStatus('Permission needed', 'Android has not granted OpenCode SI permission to run Termux commands. Grant it, then check again.', 'warning', false);
            addAction(items, 'Grant Termux permission', 'primary', function () { Bridge.requestTermuxPermission().then(function () { setTimeout(refreshChecks, 500); }, function (e) { showError('Permission request failed', e); }); });
            addAction(items, 'Open Termux', 'ghost', function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); });
            addAction(items, 'Check again', 'ghost', refreshChecks);
          } else if (m.external_apps && m.external_apps.status !== 'ok') {
            setStatus('One-time Termux setting required', 'Automatic repair is blocked because Termux rejected external commands. Follow the steps below once; SI will retry the checks when you return. Actual result: ' + (m.external_apps.detail || 'no result returned'), 'warning', false);
            checksBox.appendChild(h('div', { class: 'setup-manual-steps' },
              h('h4', null, 'Finish setup manually (one time)'),
              h('ol', null,
                h('li', null, 'Tap “Copy one-time fix command” below. It sets allow-external-apps = true and prints the saved value.'),
                h('li', null, 'Tap “Open Termux”, paste the command at the Termux prompt, and press Enter.'),
                h('li', null, 'If Android asks for shared-storage access, approve it.'),
                h('li', null, 'Wait until it prints “allow-external-apps = true”. Then open Android Settings → Apps → Termux → Force stop. Reopen Termux. (This restart is required for the setting to take effect.)'),
                h('li', null, 'Return to OpenCode SI and tap “Check again”. Setup remains pending until the live checks pass.')),
              h('pre', { class: 'setup-command-block' }, externalCommand)));
            // Keep the guided path compact, but offer a clear alternative for first-time Termux users.
            // Android permission approval cannot be automated, so the alternate panel gives explicit steps
            // and one-tap copy buttons for each command group.
            var manualAltPanel = h('div', { class: 'setup-manual-steps setup-alternate-panel', style: { display: 'none' } },
              h('h4', null, 'Manual setup — step by step'),
              h('p', { class: 'muted' }, 'Use this route if automatic setup or the first command did not work. Run commands in Termux, not in this app. Complete each step before returning here.'),
              h('ol', null,
                h('li', null, 'Open Termux. Update its package list, then upgrade installed packages. If it asks you to confirm, type y and press Enter.'),
                h('li', null, 'Run the storage setup command. If Android asks for access to photos, videos, music or files, allow the available file/storage permission.'),
                h('li', null, 'If storage permission is missing, open Android Settings → Apps → Termux → Permissions → Files/Photos and videos (wording varies by Android version). Allow the available storage/file permission.'),
                h('li', null, 'Force stop Termux from Android Settings → Apps → Termux → Force stop. Then reopen Termux. This makes the Termux settings change take effect.'),
                h('li', null, 'Back in Termux, check the shared folder and create the OpenCode SI workspace folder. The commands below do this and print the final folder details.'),
                h('li', null, 'Return to OpenCode SI and tap “Check again”. Setup is complete only when the live checks show OK.')),
              h('div', { class: 'setup-command-row' },
                h('div', null, h('strong', null, 'Step 1 — update Termux packages'), h('pre', { class: 'setup-command-block' }, 'pkg update && pkg upgrade -y')),
                h('button', { class: 'btn setup-outline', onclick: function () { Bridge.copyText('pkg update && pkg upgrade -y').then(function () { UI.toast('Package update command copied. Paste it into Termux and press Enter.'); }, function (e) { showError('Could not copy command', e); }); } }, 'Copy command')),
              h('div', { class: 'setup-command-row' },
                h('div', null, h('strong', null, 'Step 2 — request shared-storage access'), h('pre', { class: 'setup-command-block' }, 'termux-setup-storage')),
                h('button', { class: 'btn setup-outline', onclick: function () { Bridge.copyText('termux-setup-storage').then(function () { UI.toast('Storage command copied. Paste it into Termux and follow any prompt.'); }, function (e) { showError('Could not copy command', e); }); } }, 'Copy command')),
              h('div', { class: 'setup-command-row' },
                h('div', null, h('strong', null, 'Step 3 — verify and create the workspace folder'), h('pre', { class: 'setup-command-block' }, 'ls -ld ~/storage/shared\nls -ld ~/storage/shared/Download\nmkdir -p ~/storage/shared/Download/opencode-si\nls -ld ~/storage/shared/Download/opencode-si')),
                h('button', { class: 'btn setup-outline', onclick: function () { Bridge.copyText('ls -ld ~/storage/shared\nls -ld ~/storage/shared/Download\nmkdir -p ~/storage/shared/Download/opencode-si\nls -ld ~/storage/shared/Download/opencode-si').then(function () { UI.toast('Workspace commands copied. Paste them into Termux and press Enter.'); }, function (e) { showError('Could not copy commands', e); }); } }, 'Copy commands')),
              h('div', { class: 'setup-command-row' },
                h('div', null, h('strong', null, 'Step 4 — allow OpenCode SI to run Termux commands'), h('p', { class: 'muted' }, 'If the first check still says Termux rejected external commands, run this command too.'), h('pre', { class: 'setup-command-block' }, externalCommand)),
                h('button', { class: 'btn setup-outline', onclick: function () { Bridge.copyText(externalCommand).then(function () { UI.toast('Termux permission-setting command copied. Paste it into Termux.'); }, function (e) { showError('Could not copy command', e); }); } }, 'Copy command')));
            checksBox.appendChild(manualAltPanel);
            addAction(items, 'Manual / another way', 'setup-outline', function () {
              var open = manualAltPanel.style.display !== 'none';
              manualAltPanel.style.display = open ? 'none' : 'block';
              if (!open) manualAltPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
            addAction(items, 'Copy one-time fix command', 'primary', function () { Bridge.copyText(externalCommand).then(function () { UI.toast('Command copied. Paste it in Termux. Confirm it prints allow-external-apps = true, then force-stop and reopen Termux before checking again.'); }, function (e) { showError('Could not copy command', e); }); });
            addAction(items, 'Open Termux', 'ghost', function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); });
            addAction(items, 'Check again', 'ghost', refreshChecks);
          } else if (m.workspace_access && m.workspace_access.status !== 'ok') {
            var storageCommand = 'termux-setup-storage';
            setStatus('Storage access needs approval', 'The storage command can create Termux shared-storage links, but it does not enable external-app commands. This check will verify the selected workspace itself; if it still fails, inspect the exact diagnostic below.', 'warning', false);
            checksBox.appendChild(h('div', { class: 'setup-manual-steps' },
              h('h4', null, 'Finish workspace access'),
              h('p', { class: 'muted' }, 'SI tries the supported Termux command first and avoids rebuilding storage links when access is already working. The card stays visible until the live workspace check passes.'),
              h('ol', null,
                h('li', null, 'Tap “Try storage setup automatically” once. If Termux asks to rebuild existing storage links, type y and press Enter only if you choose to continue; your actual shared-storage files are not deleted.'),
                h('li', null, 'If Android shows a storage permission prompt, allow it. If no prompt appears, open Android Settings → Apps → Termux → Permissions and check the available Storage/Files permission.'),
                h('li', null, 'If automatic setup fails, tap “Copy manual storage steps”, then “Open Termux” and paste the copied command at the $ prompt. Press Enter and complete any prompt.'),
                h('li', null, 'In Termux run “ls -la ~/storage/shared” and “ls -la ~/storage/shared/Download”. Use this Termux path with the leading ~/storage/shared; “/storage/shared” by itself is not the correct path.'),
                h('li', null, 'If your selected folder is Download/opencode-si, run “mkdir -p ~/storage/shared/Download/opencode-si” and verify with “ls -ld ~/storage/shared/Download/opencode-si”. For another selected folder, create/check that matching folder instead.'),
                h('li', null, 'Return to OpenCode SI and tap “Check again”. The setup card disappears only after the real workspace check passes.')),
              h('pre', { class: 'setup-command-block' }, 'termux-setup-storage\nls -la ~/storage/shared\nls -la ~/storage/shared/Download\nmkdir -p ~/storage/shared/Download/opencode-si\nls -ld ~/storage/shared/Download/opencode-si')));
            addAction(items, 'Try storage setup automatically', 'primary', function () {
              // Use the supported Termux command bridge. If Termux refuses it, fall back to copy/paste.
              Bridge.termuxSetupStorage().then(function (r) {
                if (!r || !r.delivered || Number(r.exitCode) !== 0) throw new Error((r && (r.stderr || r.error)) || 'Termux did not confirm storage setup.');
                var out = String((r && r.stdout) || '');
                setStatus(out.indexOf('STORAGE_ACCESS_ALREADY_READY') >= 0 ? 'Storage links already work' : 'Storage setup command finished', out.indexOf('STORAGE_ACCESS_ALREADY_READY') >= 0 ? 'Termux shared-storage access was readable and writable. Checking the selected workspace now.' : 'If Android shows a permission prompt, allow it. The command result alone does not mark setup complete; run the live check again.', 'warning', false);
                setActions([{ label: 'Check again', kind: 'primary', run: refreshChecks }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); } }]);
              }).catch(function (e) {
                setStatus('Manual storage setup required', 'The automatic command was blocked: ' + (e.message || 'Termux did not accept it') + '. Copy the command below and run it directly in Termux.', 'warning', false);
                var manual = 'termux-setup-storage\nls -la ~/storage/shared\nls -la ~/storage/shared/Download\nmkdir -p ~/storage/shared/Download/opencode-si\nls -ld ~/storage/shared/Download/opencode-si';
                Bridge.copyText(manual).then(function () { UI.toast('Copied manual steps. Open Termux, paste at the $ prompt, and press Enter.'); }, function () {});
                setActions([{ label: 'Copy manual storage steps', kind: 'primary', run: function () { Bridge.copyText(manual).then(function () { UI.toast('Copied. Paste the steps in Termux and press Enter.'); }); } }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (x) { showError('Could not open Termux', x); }); } }, { label: 'Check again', kind: 'ghost', run: refreshChecks }]);
              });
            });
            addAction(items, 'Copy manual storage steps', 'ghost', function () { var manual = 'termux-setup-storage\nls -la ~/storage/shared\nls -la ~/storage/shared/Download\nmkdir -p ~/storage/shared/Download/opencode-si\nls -ld ~/storage/shared/Download/opencode-si'; Bridge.copyText(manual).then(function () { UI.toast('Copied manual steps. Open Termux, paste at the $ prompt, and press Enter. Check the output before returning to SI.'); }, function (e) { showError('Could not copy manual steps', e); }); });
            addAction(items, 'Open Termux', 'ghost', function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); });
            addAction(items, 'Check again', 'ghost', refreshChecks);
          } else {
            var completion = OpenCode.setupCompletion(latestChecks);
            if (completion.complete) {
              setStatus('Setup successfully completed!', 'All required checks passed. Termux permissions, workspace access, OpenCode installation and the server test are verified. You are ready to use OpenCode SI.', 'ok', false);
              progressTrack.hidden = false;
              progressTrack.firstChild.style.width = '100%';
              progressLabel.hidden = false;
              progressLabel.textContent = 'Complete · all checks passed';
              addAction(items, 'Done — setup complete', 'primary', function () { sheet.close(); UI.toast('OpenCode SI setup completed successfully.'); });
              addAction(items, 'View checks again', 'setup-outline', refreshChecks);
            } else {
              var missing = latestChecks.filter(function (c) { return c.status === 'failed' && ['termux_app','run_command_permission','external_apps','workspace_setting'].indexOf(c.key) < 0; });
              setStatus(missing.length ? 'Ready to repair missing components' : 'Environment checks passed', missing.length ? 'Missing items will be installed or repaired. Existing project files are not deleted.' : 'Required Termux access is working. Start the installer to verify all tools and download OpenCode if it is missing.', missing.length ? 'warning' : 'ok', false);
              addAction(items, installStarted ? 'Setup running…' : 'Install / repair components', 'primary', function () { beginInstall(); });
              addAction(items, 'Refresh checks', 'setup-outline', refreshChecks);
              addAction(items, 'Open Termux', 'setup-outline', function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); });
            }
          }
          setActions(items);
        }).catch(function (e) {
          showError('Could not check the environment', e);
          setActions([{ label: 'Retry checks', kind: 'primary', run: refreshChecks }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (x) { showError('Could not open Termux', x); }); } }]);
        });
      }
      function showError(title, e) {
        var msg = (e && e.message) || String(e || 'Unknown error');
        var code = e && e.code ? ' [' + e.code + ']' : '';
        var detail = e && e.details ? '\n\nTechnical details:\n' + Redact.text(String(e.details)) : '';
        setStatus(title + code, msg + detail, 'bad', false);
      }
      function stageText(stage) {
        return ({ PREPARING: 'Preparing installer', CHECKING_PACKAGES: 'Checking installed packages', REPAIRING_PACKAGE_CONFIGURATION: 'Repairing interrupted Termux packages', VERIFYING_CURL_RUNTIME: 'Checking download tools', REPAIRING_CURL_RUNTIME: 'Repairing curl / OpenSSL libraries', UPDATING_PACKAGE_INDEX: 'Updating Termux package list', INSTALLING_DEPENDENCIES: 'Installing Python, Git, Node.js and download tools', DOWNLOADING_OPENCODE: 'Downloading OpenCode runtime from GitHub', VERIFYING_OPENCODE_ARCHIVE: 'Verifying downloaded archive', VERIFYING_OPENCODE_EXECUTABLE: 'Testing OpenCode executable', CHECKING_EXISTING_OPENCODE: 'Checking existing OpenCode installation', VERIFYING_TOOLS: 'Verifying installed tools', COMPLETE: 'Installation steps complete' })[stage] || String(stage || 'Preparing installer').replace(/_/g, ' ').toLowerCase();
      }
      function beginInstall() {
        if (installStarted) return;
        installStarted = true;
        progressTrack.hidden = false; progressLabel.hidden = false;
        progressTrack.firstChild.style.width = '4%';
        setStatus('Starting setup in Termux', 'Preparing the app-bundled daemon installer. The first download can take several minutes; progress will update from real Termux logs.', 'muted', true);
        setActions([{ label: 'Starting…', kind: 'primary', disabled: true, run: function () {} }]);
        Bridge.beginSetupInstall().then(function () { pollProgress(); }, function (e) {
          installStarted = false;
          showError('Setup could not start', e);
          setActions([{ label: 'Retry setup', kind: 'primary', run: beginInstall }, { label: 'Refresh checks', kind: 'ghost', run: refreshChecks }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (x) { showError('Could not open Termux', x); }); } }]);
        });
      }
      function pollProgress() {
        if (closed || pollBusy) return;
        pollBusy = true;
        Bridge.setupInstallProgress().then(function (p) {
          pollBusy = false; pollFailures = 0;
          if (closed) return;
          var pct = Number(p.progressPercent);
          if (pct >= 0) progressTrack.firstChild.style.width = Math.max(4, Math.min(100, pct)) + '%';
          else if (!p.finished) progressTrack.firstChild.style.width = (4 + (Date.now() % 70)) + '%';
          progressLabel.textContent = stageText(p.stage) + (pct >= 0 && p.stage === 'DOWNLOADING_OPENCODE' ? ' · ' + Math.round(pct) + '%' : '') + (p.finished ? '' : ' · working');
          logDetails.querySelector('pre').textContent = Redact.text(p.log || 'Waiting for installer output…');
          setStatus(p.finished ? (p.success ? 'Dependencies and OpenCode installed' : 'Setup failed') : stageText(p.stage), p.finished ? (p.success ? 'Installer exited successfully. Checking daemon and OpenCode server now.' : 'The installer returned exit code ' + p.exitCode + '. Open Technical details for the actual installer output.') : 'This is live status from the Termux setup process. Keep this screen open if you want to watch progress; setup continues if you leave.', p.finished ? (p.success ? 'ok' : 'bad') : 'muted', !p.finished);
          if (!p.finished) { pollTimer = setTimeout(pollProgress, 1100); return; }
          installStarted = false;
          if (!p.success) {
            var installerLog = String(p.log || '');
            var dpkgFailed = /DPKG_CONFIGURE_FAILED|DPKG_FIX_BROKEN_FAILED|end of file on stdin at conffile prompt|dpkg returned an error code|error processing package bash/i.test(installerLog);
            var curlLinkerFailed = /CURL_RUNTIME_UPGRADE_FAILED|CURL_RUNTIME_REINSTALL_FAILED|CURL_LINKER_MISMATCH|cannot locate symbol.*SSL_set_quic_tls_early_data_enabled|CANNOT LINK EXECUTABLE ["']?curl/i.test(installerLog);
            if (curlLinkerFailed) {
              var curlRepairCommand = 'apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y && apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl';
              setStatus('Termux download tools need repair', 'The installed curl binary cannot load its TLS library. OpenCode cannot be downloaded until Termux updates and reinstalls the matching OpenSSL/libcurl packages. Copy the repair command, run it in Termux, then retry setup.', 'bad', false);
              checksBox.appendChild(h('div', { class: 'setup-manual-steps' },
                h('h4', null, 'Repair curl / OpenSSL libraries'),
                h('ol', null,
                  h('li', null, 'Tap “Copy curl repair command”.'),
                  h('li', null, 'Tap “Open Termux”, paste at the $ prompt and press Enter.'),
                  h('li', null, 'Wait for package repair to finish. Then run “curl --version” and confirm it prints a version without a linker error.'),
                  h('li', null, 'Return to OpenCode SI and tap “Retry setup”.')),
                h('pre', { class: 'setup-command-block' }, curlRepairCommand)));
              setActions([
                { label: 'Copy curl repair command', kind: 'primary', run: function () { Bridge.copyText(curlRepairCommand).then(function () { UI.toast('Copied. Open Termux, paste at the $ prompt and press Enter.'); }, function (e) { showError('Could not copy repair command', e); }); } },
                { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); } },
                { label: 'Retry setup', kind: 'ghost', run: beginInstall },
                { label: 'Refresh checks', kind: 'ghost', run: refreshChecks }
              ]);
            } else if (dpkgFailed) {
              var repairCommand = 'dpkg --force-confold --configure -a && apt-get -o Dpkg::Options::=--force-confold --fix-broken install -y';
              setStatus('Termux package repair needs one manual confirmation', 'The automatic installer detected an interrupted dpkg transaction. It tried a non-interactive safe repair, but Termux still needs a command run in its own terminal. This keeps your existing bash configuration instead of replacing it. Copy the repair command, run it at the Termux $ prompt, then return here and retry setup.', 'bad', false);
              checksBox.appendChild(h('div', { class: 'setup-manual-steps' },
                h('h4', null, 'Repair Termux packages'),
                h('ol', null,
                  h('li', null, 'Tap “Copy package repair command”.'),
                  h('li', null, 'Tap “Open Termux”, paste at the $ prompt and press Enter.'),
                  h('li', null, 'Wait for the command to finish. If another configuration prompt appears, do not guess; send the complete output.'),
                  h('li', null, 'Return to OpenCode SI and tap “Retry setup”. The app will re-check packages and continue installation.')),
                h('pre', { class: 'setup-command-block' }, repairCommand)));
              setActions([
                { label: 'Copy package repair command', kind: 'primary', run: function () { Bridge.copyText(repairCommand).then(function () { UI.toast('Copied. Open Termux, paste at the $ prompt and press Enter.'); }, function (e) { showError('Could not copy repair command', e); }); } },
                { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); } },
                { label: 'Retry setup', kind: 'ghost', run: beginInstall },
                { label: 'Refresh checks', kind: 'ghost', run: refreshChecks }
              ]);
            } else {
              setActions([{ label: 'Retry setup', kind: 'primary', run: beginInstall }, { label: 'Refresh checks', kind: 'ghost', run: refreshChecks }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (e) { showError('Could not open Termux', e); }); } }]);
            }
            return;
          }
          setActions([{ label: 'Starting daemon…', kind: 'primary', disabled: true, run: function () {} }]);
          Bridge.startDaemon().then(function () { return OpenCode.ensure(true); }).then(function (st) {
            if (st && st.state === 'READY') {
              setStatus('Setup complete', 'OpenCode is answering on 127.0.0.1:' + (st.port || 4096) + '. You can now create a project and start using SI.', 'ok', false);
              progressTrack.firstChild.style.width = '100%'; progressLabel.textContent = 'Complete · server verified';
              refreshChecks();
            } else {
              setStatus('Installed, but server is not ready', (st && st.message) || 'The installer completed, but the server health probe did not confirm readiness.', 'bad', false);
              setActions([{ label: 'Retry server start', kind: 'primary', run: function () { OpenCode.ensure(true).then(function (x) { if (x && x.state === 'READY') { setStatus('Setup complete', 'OpenCode server verified and ready.', 'ok', false); refreshChecks(); } else setStatus('Server still not ready', (x && x.message) || 'No server response.', 'bad', false); }); } }, { label: 'View diagnostics', kind: 'ghost', run: function () { logDetails.open = true; Bridge.opencodeDiagnostics().then(function (d) { logDetails.querySelector('pre').textContent = Redact.text(d.lines.join('\n')); }, function (e) { showError('Diagnostics failed', e); }); } }]);
            }
          }).catch(function (e) {
            showError('Installer finished, but service startup failed', e);
            setActions([{ label: 'Retry server start', kind: 'primary', run: function () { Bridge.startDaemon().then(function () { return OpenCode.ensure(true); }).then(refreshChecks).catch(function (x) { showError('Service startup failed', x); }); } }, { label: 'Refresh checks', kind: 'ghost', run: refreshChecks }]);
          });
        }).catch(function (e) {
          pollBusy = false;
          if (closed) return;
          pollFailures++;
          var actual = (e.message || 'Could not read installer progress') + (e.code ? ' [' + e.code + ']' : '') + (e.details ? '\n\nTechnical details: ' + Redact.text(String(e.details)) : '');
          if (pollFailures >= 3) {
            installStarted = false;
            setStatus('Progress connection is unavailable', actual + '\nThe installer may still be running in Termux. Open Termux to inspect it, or retry the progress check.', 'bad', false);
            setActions([{ label: 'Retry progress check', kind: 'primary', run: function () { pollFailures = 0; installStarted = true; pollProgress(); } }, { label: 'Open Termux', kind: 'ghost', run: function () { Bridge.openTermux().catch(function (x) { showError('Could not open Termux', x); }); } }, { label: 'Refresh environment checks', kind: 'ghost', run: refreshChecks }]);
          } else {
            setStatus('Progress connection interrupted', actual + '\nRetrying once more; setup completion will not be assumed.', 'warning', true);
            pollTimer = setTimeout(pollProgress, 1800);
          }
        });
      }
      refreshChecks();
    },

    /* ---------- model picker ---------- */
    modelLabel: function () { return OpenCode.selectedModel === 'auto' ? 'Auto' : OpenCode.selectedModel.split('/').slice(1).join('/'); },

    loadModels: function () {
      return Bridge.opencodeModels().then(function (m) { OpenCode.models = m.models; OpenCode.selectedModel = m.selected || 'auto'; Bus.emit('opencode'); return m; });
    },

    selectModel: function (id) {
      return Bridge.opencodeSetModel(id).then(function (r) { OpenCode.selectedModel = r.selected; Bus.emit('opencode'); }, function (e) { UI.toast(e.message, 'bad'); });
    },

    modelSheet: function () {
      var body = h('div', { class: 'prov-list' }, h('p', { class: 'muted' }, 'Loading the model list from OpenCode\u2026'));
      var sheet = UI.sheet({ title: 'Model', body: body });
      OpenCode.loadModels().then(function (m) {
        body.innerHTML = '';
        body.appendChild(h('button', { class: 'prov-row' + (m.selected === 'auto' ? ' active' : ''), onclick: function () { sheet.close(); OpenCode.selectModel('auto'); } },
          h('span', { class: 'prov-text' }, h('strong', null, 'Auto (OpenCode decides)'), h('span', { class: 'muted' }, 'Uses the model and agent configured in OpenCode. The app does not override it.'))));
        m.models.forEach(function (mo) {
          body.appendChild(h('button', { class: 'prov-row' + (m.selected === mo.id ? ' active' : ''), onclick: function () { sheet.close(); OpenCode.selectModel(mo.id); } },
            h('span', { class: 'prov-text' }, h('strong', null, mo.name || mo.modelID), h('span', { class: 'muted' }, mo.id))));
        });
        body.appendChild(h('p', { class: 'muted' }, 'List read from ' + (m.source === 'server' ? 'the running OpenCode server' : 'the installed OpenCode CLI') + '. Whether a model works depends on your OpenCode account and limits.'));
      }, function (e) { body.innerHTML = ''; body.appendChild(h('p', { class: 'muted' }, 'Could not load models: ' + e.message)); });
    },

    /* ---------- settings panel ---------- */
    settingsPanel: function (redraw) {
      var panel = h('section', { class: 'panel' }, h('h2', { class: 'h3' }, 'OpenCode agent'));
      var st = OpenCode.status;
      panel.appendChild(h('p', null, UI.dot(OpenCode.tone()), ' ', h('strong', null, OpenCode.label()), ' \u2014 ', st.message || ''));
      panel.appendChild(h('div', { class: 'row oc-agent-actions' },
        h('button', { class: 'btn', onclick: function () { OpenCode.openSheet(); } }, 'Status & diagnostics'),
        h('button', { class: 'btn', onclick: function () { OpenCode.setupSheet(); } }, 'Setup check'),
        st.managed && st.state === 'READY' ? h('button', { class: 'btn stop-server-action', onclick: function () { OpenCode.stop(); } }, 'Stop server') : null));

      var wsBox = h('div', { class: 'oc-ws' }, h('p', { class: 'muted' }, 'Loading folder settings\u2026'));
      panel.appendChild(h('h3', { class: 'h3' }, 'OpenCode agent workspace'));
      panel.appendChild(h('p', { class: 'muted' }, 'This setting controls where the AI reads and edits files for the current session. It does NOT choose where a new project folder is created. For that, use Projects → New project → Choose phone folder.'));
      panel.appendChild(wsBox);
      Bridge.opencodeGetWorkspace().then(function (w) {
        wsBox.innerHTML = '';
        var mode = w.mode;
        var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Workspace mode' }, [['custom', 'Chosen folder'], ['project', 'Follow open project']].map(function (o) {
          return h('button', { class: 'seg-btn' + (mode === o[0] ? ' active' : ''), onclick: function () {
            Bridge.opencodeSetWorkspace(o[0], w.custom).then(function () { return OpenCode.ensure(true); }).then(function () { redraw(); }, function (e) { UI.toast(e.message, 'bad'); });
          } }, o[1]);
        }));
        wsBox.appendChild(seg);
        var path = h('input', { class: 'input', type: 'text', value: w.custom, autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Folder path' });
        wsBox.appendChild(h('div', { class: 'row' }, path,
          h('button', { class: 'btn', onclick: function () {
            Bridge.opencodeSetWorkspace('custom', path.value.trim()).then(function () { UI.toast('Applying\u2026'); return OpenCode.ensure(true); }).then(function (s) { UI.toast(s.state === 'READY' ? 'OpenCode is working in that folder' : s.message, s.state === 'READY' ? '' : 'bad'); redraw(); }, function (e) { UI.toast(e.message, 'bad'); });
          } }, 'Use folder'),
          h('button', { class: 'btn', onclick: function () { Bridge.opencodePickWorkspace().then(function () {}, function (e) { UI.toast(e.message, 'bad'); }); } }, 'Pick\u2026')));
        wsBox.appendChild(h('p', { class: 'muted' }, mode === 'project'
          ? 'Current agent workspace: ' + (w.effective || w.problem || 'none open') + '. Files, Git and Terminal follow the open project. This setting does not set the parent folder for future projects.'
          : 'Agent workspace: ' + (w.custom || 'not set') + '. This changes only where the AI works; it does not move the open project or set the location for future projects. Files, Git and Terminal follow the project opened in the app.'));
        wsBox.appendChild(h('p', { class: 'muted' }, 'Local mode requires Termux with the OpenCode CLI/server and daemon installed. Shared phone storage also requires Termux storage permission. Without Termux, this local backend cannot run.'));
      }, function (e) { wsBox.innerHTML = ''; wsBox.appendChild(h('p', { class: 'muted' }, e.message)); });

      panel.appendChild(h('h3', { class: 'h3' }, 'Model'));
      panel.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: OpenCode.modelSheet }, 'Model: ' + OpenCode.modelLabel())));
      panel.appendChild(h('p', { class: 'muted' }, 'Auto keeps the model behaviour you configured in OpenCode. The list is read from OpenCode, not built into the app.'));

      var pw = h('input', { class: 'input', type: 'password', placeholder: 'Password of a server you started yourself', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'OpenCode server password' });
      panel.appendChild(h('details', null, h('summary', null, 'Server password (only if you started the server yourself)'),
        h('p', { class: 'muted' }, 'If you start `opencode serve` by hand with OPENCODE_SERVER_PASSWORD, enter that password here. It is stored in the Android Keystore and never shown again.'),
        h('div', { class: 'row' }, pw, h('button', { class: 'btn', onclick: function () {
          var v = pw.value.trim();
          if (!v) { UI.toast('Enter the password first', 'bad'); return; }
          Bridge.opencodeSetPassword(v).then(function () { pw.value = ''; UI.toast('Saved'); return OpenCode.ensure(true); }, function (e) { UI.toast(e.message, 'bad'); });
        } }, 'Save'))));
      return panel;
    }
  };

  g.OpenCode = OpenCode;
})(window);
