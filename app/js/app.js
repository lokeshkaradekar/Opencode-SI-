/* app.js — boot, Home (project manager), Settings, Android lifecycle hooks. */
(function (g) {
  'use strict';
  var h = UI.h;

  var App = {};

  /* ---------- project manager (Phase 4) ---------- */
  App.openProject = function (id) {
    var meta = Persist.get('project-meta', {}); meta[id] = meta[id] || {}; meta[id].lastOpened = Date.now(); Persist.set('project-meta', meta);
    return Bridge.openProject(id).then(function (p) {
      // SI and the Files browser must operate on the same directory. The selected project
      // is the app's source of truth; a stale custom OpenCode workspace can otherwise let
      // the agent write files elsewhere (e.g. /storage/emulated/0/Ringtones) that Files
      // can never list. Switch the OpenCode server to the selected project workspace.
      var alignWorkspace = Bridge.opencodeSetWorkspace
        ? Bridge.opencodeSetWorkspace('project').catch(function (e) {
            UI.toast('Could not align OpenCode workspace with this project: ' + (e.message || 'unknown error'), 'warn');
          })
        : Promise.resolve();
      return alignWorkspace.then(function () {
        Files.reset();
        Terminal.lines = []; Terminal.exit = null; Terminal.running = false;
        State.set({ project: p, screen: 'project', tab: 'ai' });
        Agent.load(p.id);
        Router.render();
        Editor.restore(p.id);
        return Health.run().then(function (hl) {
          if (hl.status !== 'ok') UI.toast('The environment needs attention. Open Health to repair it.', 'warn');
        });
      });
    }, function (e) { UI.toast(Errors.classify(e, e.code).title + ': ' + e.message, 'bad'); });
  };

  App.home = function (el) {
    var list = h('ul', { class: 'projects' });
    var envLine = h('p', { class: 'muted env-line' }, 'Checking this device\u2026');
    var setupBanner = h('section', { class: 'panel home-setup-pending', 'aria-live': 'polite' },
      h('div', { class: 'home-setup-head' }, UI.dot('warning'), h('h2', { class: 'h3' }, 'Finish setting up OpenCode SI')),
      h('p', { class: 'muted home-setup-detail' }, 'Checking Termux permissions, workspace access and the OpenCode server…'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: function () { OpenCode.setupSheet(); } }, 'Continue setup'),
        h('button', { class: 'btn', onclick: function () { checkHomeSetup(); } }, 'Check again')));
    var setupDetail = setupBanner.querySelector('.home-setup-detail');
    var setupCheckBusy = false;

    function checkHomeSetup() {
      if (setupCheckBusy || State.backend === 'remote') return;
      setupCheckBusy = true;
      setupBanner.hidden = false;
      setupDetail.textContent = 'Checking Termux permissions, workspace access and the OpenCode server…';
      OpenCode.checkSetupCompletion().then(function (r) {
        if (State.backend === 'remote') { setupBanner.hidden = true; return; }
        if (r.result.complete) {
          setupBanner.hidden = true;
          Persist.set('oc.setupCompletedAt', Date.now());
          return;
        }
        Persist.del('oc.setupCompletedAt');
        setupBanner.hidden = false;
        var names = { termux_app: 'Termux installation', run_command_permission: 'Android Termux command permission', external_apps: 'Termux external-command setting', workspace_access: 'workspace storage access', opencode_found: 'OpenCode installation', opencode_runs: 'OpenCode executable', server_running: 'OpenCode server', server_health: 'server health check', test_session: 'test session' };
        var first = r.result.missing[0];
        var c = r.result.checks[first];
        setupDetail.textContent = 'Setup is not complete: ' + (names[first] || first) + '. ' + ((c && c.detail) || 'Complete the guided setup, then run the checks again.');
      }).catch(function (e) {
        setupBanner.hidden = false;
        setupDetail.textContent = 'Setup status could not be verified: ' + ((e && e.message) || 'unknown error') + '. Continue setup or check again.';
      }).then(function () { setupCheckBusy = false; });
    }

    var PROJECT_META_KEY = 'project-meta';
    function projectMeta() { return Persist.get(PROJECT_META_KEY, {}); }
    function saveProjectMeta(meta) { Persist.set(PROJECT_META_KEY, meta); }

    function projectMenu(p, reload) {
      var meta = projectMeta();
      var pinned = !!(meta[p.id] && meta[p.id].pinned);
      var s = UI.sheet({
        title: p.name,
        body: h('div', { class: 'menu-list' },
          h('button', { class: 'menu-item', onclick: function () {
            s.close();
            UI.prompt('Rename project', 'New project name', p.name, 'Rename').then(function (name) {
              name = (name || '').trim(); if (!name || name === p.name) return;
              Bridge.renameProject(p.id, name).then(function (renamed) {
                var m = projectMeta(); if (m[p.id]) { m[name] = m[p.id]; delete m[p.id]; } saveProjectMeta(m);
                if (State.project && State.project.id === p.id) {
                  State.project.id = renamed.id; State.project.name = renamed.name;
                  // Renaming an open folder changes its filesystem path. Re-align OpenCode
                  // before loading the new session so the agent cannot keep writing to the old path.
                  var align = Bridge.opencodeSetWorkspace
                    ? Bridge.opencodeSetWorkspace('project').catch(function (e) { UI.toast('Project renamed, but workspace switch failed: ' + (e.message || 'unknown error'), 'warn'); })
                    : Promise.resolve();
                  align.then(function () { Agent.load(renamed.id); });
                }
                UI.toast('Project renamed'); reload();
              }, function (e) { UI.toast(e.message || 'Could not rename project', 'bad'); });
            });
          } }, h('span', { class: 'ico-wrap' }, UI.icon('edit', 20)), 'Rename'),
          h('button', { class: 'menu-item', onclick: function () {
            s.close(); var m = projectMeta(); m[p.id] = m[p.id] || {};
            m[p.id].pinned = !m[p.id].pinned;
            saveProjectMeta(m);
            // Read it back before refreshing so storage failures are not reported as success.
            var saved = projectMeta();
            if (!saved[p.id] || !!saved[p.id].pinned !== !!m[p.id].pinned) {
              UI.toast('Could not save project pin state. Check WebView storage permissions.', 'bad');
              return;
            }
            UI.toast(m[p.id].pinned ? 'Project pinned' : 'Project unpinned'); reload();
          } }, h('span', { class: 'ico-wrap' }, UI.icon('pin', 20)), pinned ? 'Unpin' : 'Pin'),
          h('button', { class: 'menu-item danger', onclick: function () {
            s.close();
            UI.confirm('Delete project ' + p.name + '?', 'This permanently deletes the project folder and all files inside it. This cannot be undone.', 'Delete project', true).then(function (ok) {
              if (!ok) return;
              Bridge.deleteProject(p.id).then(function () {
                // Clear every app-side session/task/editor reference before a folder with the same
                // name can be created again. Otherwise Agent.load() restores the old session ID
                // because the project ID is the folder name and therefore gets reused.
                if (typeof Agent !== 'undefined' && Agent.resetProjectData) Agent.resetProjectData(p.id);
                var m = projectMeta(); delete m[p.id]; saveProjectMeta(m);
                if (State.project && State.project.id === p.id) { State.set({ project: null, screen: 'home', tab: 'ai' }); Router.render(); }
                UI.toast('Project deleted'); reload();
              }, function (e) { UI.toast(e.message || 'Could not delete project', 'bad'); });
            });
          } }, h('span', { class: 'ico-wrap' }, UI.icon('x', 20)), 'Delete')
        )
      });
    }

    function loadList() {
      Bridge.listProjects().then(function (items) {
        var meta = projectMeta();
        items.sort(function (a, b) {
          var ma = meta[a.id] || {}, mb = meta[b.id] || {};
          if (!!ma.pinned !== !!mb.pinned) return ma.pinned ? -1 : 1;
          return (mb.lastOpened || b.updated || 0) - (ma.lastOpened || a.updated || 0);
        });
        list.innerHTML = '';
        if (!items.length) {
          list.appendChild(h('li', { class: 'empty' }, h('h2', { class: 'h2' }, 'No projects yet'), h('p', { class: 'muted' }, 'Create a project or clone a repository to start.')));
        }
        items.forEach(function (p) {
          list.appendChild(h('li', { class: 'project-row' },
            h('button', { class: 'project', onclick: function () { App.openProject(p.id); } },
              h('span', { class: 'project-name' }, p.name),
              h('span', { class: 'muted' }, (meta[p.id] && meta[p.id].pinned ? 'Pinned · ' : '') + 'Opened ' + UI.timeAgo((meta[p.id] && meta[p.id].lastOpened) || p.updated)),
              h('span', { class: 'project-meta' }, h('span', { class: 'chip' }, p.backend), h('span', { class: 'chip' }, p.agent))),
            h('button', { class: 'icon-btn project-more', 'aria-label': 'Project options', onclick: function () { projectMenu(p, loadList); } }, UI.icon('more'))
          ));
        });
      }, function (e) { list.innerHTML = ''; list.appendChild(h('li', null, UI.errorCard(Errors.classify(e, e.code), []))); });
    }

    function newProject() {
      UI.prompt('New project', 'Project name', '', 'Continue').then(function (name) {
        if (!name) return;
        if (Bridge.mode !== 'native') {
          UI.toast('Project creation requires the installed OpenCode SI Android app and its configured backend.', 'bad');
          return;
        }
        function create(parent) {
          UI.toast('Creating project…');
          Bridge.createProject(name, parent || '').then(function (p) {
            var actual = String((p && p.path) || '').replace(/\\/g, '/').replace(/\/$/, '');
            var expected = parent ? String(parent).replace(/\\/g, '/').replace(/\/$/, '') + '/' + name : '';
            if (parent && actual && actual !== expected) {
              // Older Termux daemons ignore the optional parent field. The project has
              // already been created, so never abandon it on the home screen: refresh the
              // list and open the real path returned by the backend. Otherwise the folder
              // remains hidden in the UI and the next attempt misleadingly says it exists.
              UI.toast('This Termux daemon ignored the selected folder and created the project at ' + actual + '. Opening the created project now. Run Setup again to update the daemon, then retry custom locations.', 'bad');
              loadList();
              App.openProject(p.id);
              return;
            }
            UI.toast('Project created at ' + (actual || (parent ? expected : '~/OpenCodeProjects/' + name)));
            loadList();
            App.openProject(p.id);
          }, function (e) {
            var msg = e.message || 'Could not create project';
            if (e.code === 'SETUP_REQUIRED') {
              msg = 'Custom folder creation was safely blocked because the running daemon is outdated. Open Health → Setup, wait for Setup to finish successfully, then retry. No project was created in the wrong folder.';
            } else if (e.code === 'PROJECT_PATH_MISMATCH') {
              msg = e.message || 'The backend returned a different project path. The app refused to open it.';
            } else if (e.code === 'BACKEND_UNAVAILABLE' || /Termux is not installed/i.test(msg)) {
              msg = 'Termux is required for the current local OpenCode backend. Install and configure Termux, or use a future remote/standalone backend.';
            } else if (/permission|storage|access denied/i.test(msg)) {
              msg += ' For a phone-storage folder, grant Termux shared-storage access using termux-setup-storage, then retry.';
            }
            UI.toast(msg, 'bad');
          });
        }
        if (typeof Bridge.pickProjectLocation !== 'function') {
          UI.toast('This build cannot open Android’s folder picker. Update the Android bridge before creating a custom-location project.', 'bad');
          return;
        }
        var s = UI.sheet({
          title: 'Project location',
          body: h('div', { class: 'project-location-choice' },
            h('p', null, 'Choose where the project folder will actually be created.'),
            h('p', { class: 'muted' }, 'This choice sets the actual parent folder for the new project. Default creates it under Termux home. Choose phone folder to create it inside that exact folder. The Settings → OpenCode agent workspace field is different: it controls where the AI works after a project is open. Phone storage requires Termux storage permission (run termux-setup-storage in Termux if needed).')),
          actions: [
            { label: 'Default (Termux)', kind: 'ghost', onClick: function () { create(''); } },
            { label: 'Choose phone folder', kind: 'primary', onClick: function () {
              var done = false;
              var listener = function (result) {
                if (done) return;
                done = true;
                Bridge.off('project.location.picked', listener);
                if (!result || result.error) { if (result && result.error) UI.toast(result.error, 'bad'); return; }
                var parent = String(result.path || '').trim();
                if (!parent) { UI.toast('No folder was selected.', 'warn'); return; }
                create(parent);
              };
              Bridge.on('project.location.picked', listener);
              Bridge.pickProjectLocation().catch(function (e) {
                if (done) return;
                done = true;
                Bridge.off('project.location.picked', listener);
                UI.toast(e.message || 'Could not open Android folder picker', 'bad');
              });
            } }
          ]
        });
      });
    }
    function clone() {
      UI.prompt('Clone repository', 'Repository URL (https or ssh)', 'https://', 'Clone').then(function (url) {
        if (!url) return;
        UI.toast('Cloning\u2026');
        Bridge.cloneProject(url).then(function (p) { App.openProject(p.id); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    }
    function importZip() {
      Bridge.importZip().then(function () { loadList(); }, function (e) { UI.toast(e.message, e.code === 'NOT_IMPLEMENTED' ? '' : 'bad'); });
    }

    el.appendChild(h('div', { class: 'home' },
      envLine,
      setupBanner,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: newProject }, UI.icon('plus', 18), 'New project'),
        h('button', { class: 'btn', onclick: clone }, 'Clone repository'),
        h('button', { class: 'btn', onclick: importZip }, 'Import ZIP')),
      list));
    loadList();
    checkHomeSetup();
    Bridge.getEnvironment().then(function (env) {
      envLine.textContent = env.backend === 'remote'
        ? 'Remote workspace \u00b7 ' + env.remoteHost
        : 'Android ' + env.android.version + ' \u00b7 ' + (env.arch === 'arm64-v8a' ? 'ARM64' : env.arch) + ' \u00b7 Termux ' + env.termux;
    }, function (e) { envLine.textContent = Errors.classify(e, e.code).simple; });
    var offSetupChecks = Bus.on('setup.checks', function () { if (State.screen === 'home') checkHomeSetup(); });
    return function () { offSetupChecks(); };
  };

  /* ---------- settings ---------- */
  App.settings = function (el) {
    var root = h('div', { class: 'settings' });
    el.appendChild(root);

    function seg(options, value, onPick, label) {
      return h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': label }, options.map(function (o) {
        return h('button', { class: 'seg-opt' + (o[0] === value ? ' on' : ''), role: 'radio', 'aria-checked': o[0] === value, onclick: function () { onPick(o[0]); } }, o[1]);
      }));
    }

    function draw() {
      root.innerHTML = '';

      root.appendChild(h('section', { class: 'panel' },
        h('h2', { class: 'h3' }, 'Appearance'),
        h('p', { class: 'muted' }, 'Pick a theme. It applies everywhere right away and is remembered next time you open the app.'),
        h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, THEMES.map(function (t) {
          var on = State.theme === t.id;
          return h('button', {
            class: 'theme-card' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on,
            onclick: function () { State.theme = t.id; Persist.set('theme', t.id); applyTheme(); draw(); }
          },
            h('span', { class: 'theme-swatch' },
              h('span', { class: 'sw', style: { background: t.swatch[0] } }),
              h('span', { class: 'sw', style: { background: t.swatch[1] } }),
              h('span', { class: 'sw', style: { background: t.swatch[2] } })),
            h('span', { class: 'theme-text' },
              h('strong', null, t.name),
              h('span', { class: 'muted' }, t.desc)),
            on ? h('span', { class: 'theme-check' }, '\u2713') : null);
        }))));

      root.appendChild(h('section', { class: 'panel' },
        h('h2', { class: 'h3' }, 'Where code runs'),
        seg([['local', 'This phone (Termux)'], ['remote', 'Remote workspace']], State.backend, function (v) {
          (v === 'remote' ? Health.useRemote() : Health.useLocal()).then(function () { UI.toast(v === 'remote' ? 'Using the remote workspace' : 'Using this phone'); draw(); });
        }, 'Execution backend'),
        h('p', { class: 'muted' }, 'If the local environment breaks, Health can move your session to the remote workspace without touching your project.')));

      root.appendChild(OpenCode.settingsPanel(draw));

      root.appendChild(h('section', { class: 'panel' },
        h('details', null, h('summary', { class: 'h3' }, 'Direct model providers (legacy, not used for chat)'),
          h('p', { class: 'muted' }, 'Chat always goes through the OpenCode agent. These settings only affect the old direct-provider probe and are kept for compatibility. Keys are stored in the Android Keystore and never sent to the agent.'),
          h('div', { class: 'prov-settings' }, Gateway.providers.map(providerBlock)))));

      root.appendChild(h('section', { class: 'panel' },
        h('h2', { class: 'h3' }, 'About'),
        h('p', { class: 'muted' }, Bridge.mode === 'native' ? 'Running on Android. Files, Git, terminal and the agent run for real in Termux.' : (Bridge.mode === 'mock' ? 'DEVELOPMENT MOCK (dev.html): nothing here is real.' : 'No native bridge: this page is not inside the Android app, so there is no backend.')),
        h('p', { class: 'muted' }, 'Agent: official OpenCode (via the OpenCode server in Termux) \u00b7 Bridge: ' + Bridge.mode),
        h('div', { class: 'row wrap support-actions' },
          h('button', { class: 'btn', onclick: function () { Router.go('help'); } }, UI.icon('report', 18), ' Help & FAQ'),
          h('button', { class: 'btn', onclick: function () { Router.go('contact'); } }, UI.icon('link', 18), ' Contact & feedback'))));
    }

  function providerBlock(p) {
      var st = Gateway.status[p.id] || { status: 'unknown', detail: 'Not checked' };
      var key = h('input', { class: 'input', type: 'password', placeholder: 'Paste API key', autocomplete: 'off', autocapitalize: 'off', 'aria-label': p.name + ' API key' });
      if (!Gateway.config[p.id]) Gateway.loadConfig(p.id).then(function () { draw(); }, function () {});
      var cfg = Gateway.config[p.id] || { baseUrl: '', model: '' };
      var url = h('input', { class: 'input', type: 'url', value: cfg.baseUrl || '', placeholder: 'https://host/v1', autocomplete: 'off', autocapitalize: 'off', 'aria-label': p.name + ' base URL' });
      var model = h('input', { class: 'input', type: 'text', value: cfg.model || '', placeholder: 'Model id', autocomplete: 'off', autocapitalize: 'off', list: 'models-' + p.id, 'aria-label': p.name + ' model' });
      var dl = h('datalist', { id: 'models-' + p.id }, (Gateway.models[p.id] || []).slice(0, 200).map(function (m) { return h('option', { value: m.id }); }));
      var block = h('div', { class: 'prov-block' },
        h('div', { class: 'prov-top' }, UI.dot(st.status), h('strong', null, p.name), h('span', { class: 'muted' }, st.detail)),
        h('p', { class: 'muted' }, p.desc),
        h('div', { class: 'row' }, url), h('div', { class: 'row' }, model, dl,
          h('button', { class: 'btn', onclick: function () {
            Gateway.saveConfig(p.id, url.value.trim(), model.value.trim()).then(function () { return Gateway.check(p.id); }).then(function (s) { UI.toast(s.status === 'ok' ? 'Saved. Provider reachable.' : 'Saved. ' + s.detail, s.status === 'failed' ? 'bad' : ''); draw(); }, function (e) { UI.toast(e.message, 'bad'); });
          } }, 'Save'),
          h('button', { class: 'btn ghost', onclick: function () {
            Gateway.fetchModels(p.id).then(function (m) { UI.toast(m.length + ' models found'); draw(); }, function (e) { UI.toast(e.message, 'bad'); });
          } }, 'List models')));
      if (p.needsKey) {
        block.appendChild(h('div', { class: 'row' }, key,
          h('button', { class: 'btn', onclick: function () {
            var v = key.value.trim();
            if (!v) { UI.toast('Paste a key first', 'bad'); return; }
            Gateway.saveKey(p.id, v).then(function (s) { key.value = ''; UI.toast(s.status === 'ok' ? 'Key saved and accepted' : 'Key saved. ' + s.detail); draw(); }, function (e) { UI.toast(e.message, 'bad'); });
          } }, 'Save'),
          h('button', { class: 'btn ghost', onclick: function () { Gateway.removeKey(p.id).then(function () { UI.toast('Key removed'); draw(); }); } }, 'Remove')));
      }
      return block;
    }


    draw();
    var offOc = Bus.on('opencode', draw);
    return function () { offOc(); };
  };

  /* ---------- Help / FAQ ---------- */
  App.help = function (el) {
    var root = h('div', { class: 'support-page' });
    root.appendChild(h('section', { class: 'panel support-hero' },
      h('div', { class: 'support-eyebrow' }, 'OPENCODE SI SUPPORT'),
      h('h2', { class: 'h2' }, 'How can we help?'),
      h('p', { class: 'muted' }, 'Quick answers for projects, chat, files, server status, and troubleshooting.')));

    function faq(title, summary, detail) {
      return h('details', { class: 'support-faq' },
        h('summary', null, title),
        h('div', { class: 'support-answer' }, h('p', null, summary), detail ? h('p', { class: 'muted' }, detail) : null));
    }
    root.appendChild(h('section', { class: 'panel' },
      h('h2', { class: 'h3' }, 'Frequently asked questions'),
      faq('Which server does OpenCode SI use?',
        'By default, this app runs the official OpenCode CLI/server locally through Termux on your Android device. The app connects to the local server at 127.0.0.1:4096 when that is the configured port. It is not a server hosted by the GitHub account listed in Contact.',
        'The app can also be configured for a Remote workspace in Settings. The active backend and server status are shown in the app. The detected OpenCode version depends on the installation; some builds report 1.18.33-termux.'),
      faq('Where are my project files?',
        'For the default local setup, projects are normally stored under the Termux home directory in OpenCodeProjects. The Files tab should show files inside the selected project/workspace.',
        'If the agent and Files tab appear to show different files, open Settings → OpenCode workspace and choose Follow open project, then return to Files and refresh. Files created outside the selected workspace will not automatically appear in its file list.'),
      faq('Why does the server show Needs attention?',
        'Open Health and review the OpenCode server status and Technical details. If the app-managed local server has stopped or is not responding, use Repair once and wait for the health check to finish.',
        'If this keeps happening, include the exact error text, whether you were using a task, and whether Repair restored Healthy status when contacting support. Do not send API keys, passwords, or server tokens.'),
      faq('Why is a task stuck on Thinking or Working?',
        'A task activity indicator should reflect the active task. First wait briefly and check whether the assistant response or tool activity appears. If it remains stuck, avoid sending repeated copies of the same request; check Health and inspect the task history.',
        'When reporting this, include how many messages were sent before it happened, whether you changed projects or tabs, and a screenshot of the header plus chat activity.'),
      faq('How do I start a fresh conversation?',
        'Open the SI chat and use Restart chat, then confirm. This starts a fresh session reference for the current project; it does not delete your project files or erase server-side session history.'),
      faq('Does OpenCode SI itself provide an AI model?',
        'OpenCode SI is the app interface and integration layer. The OpenCode agent/server runs the coding workflow, while the model/provider used for responses depends on the OpenCode configuration. This app should not be described as using OpenAI or any specific model unless that provider/model is actually configured.'),
      faq('How can I report a bug?',
        'Open Contact & feedback from the app menu. Include the steps to reproduce the issue, what you expected, what happened, and relevant non-sensitive error details. You can also open the project maintainer GitHub profile.',
        'Please remove personal paths, access tokens, API keys, passwords, and private source code before sharing screenshots or logs.')));

    root.appendChild(h('section', { class: 'panel support-next' },
      h('h2', { class: 'h3' }, 'Still need help?'),
      h('p', { class: 'muted' }, 'Send a reproducible bug report or open the maintainer profile.'),
      h('button', { class: 'btn primary support-full', onclick: function () { Router.go('contact'); } }, 'Contact & feedback')));
    el.appendChild(root);
    return function () {};
  };

  /* ---------- Contact / Feedback ---------- */
  App.contact = function (el) {
    var root = h('div', { class: 'support-page' });
    root.appendChild(h('section', { class: 'panel support-hero' },
      h('div', { class: 'support-eyebrow' }, 'CONTACT & FEEDBACK'),
      h('h2', { class: 'h2' }, 'Help improve OpenCode SI'),
      h('p', { class: 'muted' }, 'Report a bug, share feedback, or contact the project maintainer.')));

    function supportAction(label, detail, destination, icon) {
      return h('button', { class: 'support-contact-row', onclick: function () {
        if (!Bridge.openSupportLink) { UI.toast('This action requires the Android app build.', 'warn'); return; }
        Bridge.openSupportLink(destination).catch(function (e) { UI.toast(e.message || 'Could not open the selected app', 'bad'); });
      } },
        h('span', { class: 'support-contact-icon' }, UI.icon(icon, 22)),
        h('span', { class: 'support-contact-copy' }, h('strong', null, label), h('span', { class: 'muted' }, detail)),
        UI.icon('chevron', 18));
    }
    root.appendChild(h('section', { class: 'panel' },
      h('h2', { class: 'h3' }, 'Official contact details'),
      supportAction('Email support / feedback', 'lokeshkaradekar7@gmail.com', 'email', 'report'),
      supportAction('GitHub profile', 'github.com/lokeshkaradekar', 'github', 'link'),
      h('p', { class: 'muted support-note' }, 'Maintainer credit: Made by GitHub account @lokeshkaradekar. This is the maintainer contact supplied for this app; it does not mean GitHub hosts the OpenCode server.')));

    var subject = h('input', { class: 'input', type: 'text', maxlength: '120', placeholder: 'Short subject (e.g. Thinking indicator disappears)', 'aria-label': 'Feedback subject' });
    var message = h('textarea', { class: 'input support-textarea', maxlength: '5000', placeholder: 'Describe the steps, expected result, actual result, and any non-sensitive error message…', 'aria-label': 'Feedback message' });
    root.appendChild(h('section', { class: 'panel' },
      h('h2', { class: 'h3' }, 'Prepare a bug report'),
      h('p', { class: 'muted' }, 'This form opens your email app with the report filled in; it does not silently upload or send your message.'),
      h('label', { class: 'support-label' }, 'Subject', subject),
      h('label', { class: 'support-label' }, 'What happened?', message),
      h('button', { class: 'btn primary support-full', onclick: function () {
        var sub = subject.value.trim() || 'OpenCode SI feedback';
        var body = message.value.trim();
        if (!body) { UI.toast('Describe the issue before preparing the report.', 'warn'); message.focus(); return; }
        if (!Bridge.openSupportLink) { UI.toast('This action requires the Android app build.', 'warn'); return; }
        Bridge.openSupportLink('feedback', { subject: sub, body: body }).catch(function (e) { UI.toast(e.message || 'Could not open email app', 'bad'); });
      } }, 'Prepare email report')));

    root.appendChild(h('section', { class: 'panel support-privacy' },
      h('h2', { class: 'h3' }, 'Before sending'),
      h('p', { class: 'muted' }, 'Never include API keys, passwords, server tokens, private certificates, or sensitive personal data. Add screenshots only after checking that they do not expose secrets.')));
    el.appendChild(root);
    return function () {};
  };


  /* ---------- viewport height fallback ----------
     Measures the real visible height and exposes it as --app-vh (1% of it) for app.css's
     `calc(var(--app-vh, 1vh) * 100)` fallback (see the comment on #app there). window.visualViewport is
     preferred where present: on WebViews that support it, its height tracks the keyboard precisely and
     excludes it, which innerHeight does not always do. Falls back to window.innerHeight otherwise, which
     still updates on most Android WebView versions when the keyboard opens even without visualViewport
     or dvh/interactive-widget support. Re-measures on resize and on focusin/focusout (keyboard open/close
     is not always a 'resize' event on every WebView version) so the composer stays reachable either way. */
  function setViewportHeightVar() {
    var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    if (h) document.documentElement.style.setProperty('--app-vh', (h * 0.01) + 'px');
  }
  setViewportHeightVar();
  window.addEventListener('resize', setViewportHeightVar);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', setViewportHeightVar);
  document.addEventListener('focusin', setViewportHeightVar);
  document.addEventListener('focusout', setViewportHeightVar);

  /* Pull down from the top of a screen to refresh its real data without restarting WebView. */
  (function installPullToRefresh() {
    var startY = 0, startX = 0, tracking = false, fired = false;
    var threshold = 86;
    var indicator = document.createElement('div');
    indicator.className = 'pull-refresh-indicator';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.textContent = 'Pull down to refresh';
    document.getElementById('app').appendChild(indicator);
    function canPullFrom(target) {
      var node = target;
      while (node && node !== document.body && node.id !== 'screen') {
        if (node.scrollHeight > node.clientHeight + 2 && node.scrollTop > 2) return false;
        node = node.parentElement;
      }
      var screen = document.getElementById('screen');
      return !screen || screen.scrollTop <= 2;
    }
    document.addEventListener('touchstart', function (ev) {
      if (!ev.touches || ev.touches.length !== 1 || !canPullFrom(ev.target)) { tracking = false; return; }
      startY = ev.touches[0].clientY; startX = ev.touches[0].clientX;
      tracking = startY < 260; fired = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (ev) {
      if (!tracking || !ev.touches || ev.touches.length !== 1) return;
      var dy = ev.touches[0].clientY - startY, dx = ev.touches[0].clientX - startX;
      if (dy < 0 || Math.abs(dx) > Math.abs(dy) * .8) { indicator.classList.remove('visible', 'ready'); return; }
      if (dy > 18) {
        indicator.classList.add('visible');
        indicator.classList.toggle('ready', dy >= threshold);
        indicator.textContent = dy >= threshold ? 'Release to refresh' : 'Pull down to refresh';
      }
    }, { passive: true });
    document.addEventListener('touchend', function (ev) {
      if (!tracking) return;
      var dy = ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY - startY : 0;
      tracking = false;
      if (dy >= threshold && !fired) {
        fired = true; indicator.classList.add('refreshing'); indicator.textContent = 'Refreshing…';
        Promise.resolve(typeof Router !== 'undefined' && Router.refresh ? Router.refresh() : null).then(function () {
          indicator.textContent = 'Refreshed';
        }).catch(function () { indicator.textContent = 'Refresh finished with an issue'; }).then(function () {
          setTimeout(function () { indicator.classList.remove('visible', 'ready', 'refreshing'); indicator.textContent = 'Pull down to refresh'; }, 900);
        });
      } else indicator.classList.remove('visible', 'ready');
    }, { passive: true });
    document.addEventListener('touchcancel', function () { tracking = false; indicator.classList.remove('visible', 'ready'); }, { passive: true });
  })();

  /* ---------- Android lifecycle (called from MainActivity.java) ---------- */
  g.onAndroidBack = function () { return Router.back(); };
  g.onAndroidLifecycle = function (ev) {
    if (ev === 'pause') Editor.flush();
    if (ev === 'resume') OpenCode.onResume();
    if (ev === 'resume' && State.screen === 'project') Health.run({ silent: true });
  };
  window.addEventListener('pagehide', function () { Editor.flush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) Editor.flush(); });

  // The agent, Git and editor all react to file changes made elsewhere.
  Bus.on('files', function () { Editor.refresh(); });

  window.addEventListener('error', function (e) { console.error('Uncaught:', e.message); });
  window.addEventListener('unhandledrejection', function (e) { console.error('Unhandled rejection:', e.reason); });

  g.App = App;

  function boot() {
    applyTheme();
    // Render the local UI immediately; do not leave a white/empty page waiting for
    // the Termux environment bridge to answer. The backend label is refreshed below.
    try { Router.render(); g.__OPENCODE_SI_UI_READY = true; } catch (initialRenderError) { console.error('Initial UI render failed:', initialRenderError); }
    if (Bridge.mode === 'native') {
      // First run: ask for the Termux RUN_COMMAND permission if it is missing (the result arrives as a 'permission' event).
      Bridge.daemonStatus().then(function (d) {
        if (d.termuxInstalled && !d.runCommandPermission) Bridge.requestTermuxPermission().then(function () {}, function () {});
      }, function () {});
    }
    // Check, and if needed start, the official OpenCode server through Termux. Joins any start already in progress.
    OpenCode.start().then(function () {
      if (Bridge.mode !== 'native') return;
      // Never persist a 'wizard already shown' flag: incomplete setup is retried on every cold launch.
      OpenCode.checkSetupCompletion().then(function (r) {
        if (!r.result.complete && State.backend !== 'remote') {
          setTimeout(function () { if (State.backend !== 'remote') OpenCode.setupSheet(); }, 350);
        } else if (r.result.complete) {
          Persist.set('oc.setupCompletedAt', Date.now());
        }
      }).catch(function () {
        // Unknown is not complete. Home retains the persistent recovery entry point.
      });
    }, function () {
      // Startup failure must not suppress recovery UI on later launches.
    });
    Bridge.getEnvironment().then(function (env) { State.backend = env.backend || 'local'; }, function () {}).then(function () {
      Router.render();
      // Native resume watchdog uses this marker to distinguish a rendered app from a blank WebView.
      g.__OPENCODE_SI_UI_READY = true;
    }, function (e) {
      console.error('App environment initialization failed:', e);
      // Render a usable shell even if the environment bridge temporarily fails.
      try { Router.render(); g.__OPENCODE_SI_UI_READY = true; } catch (renderError) { console.error(renderError); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
