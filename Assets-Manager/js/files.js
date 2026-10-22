/* files.js — file tree (lazy, paginated), search, create/rename/delete, and the
   host that switches between the tree and the editor. Large repositories are
   never loaded at once: each folder is listed only when expanded, 200 rows at a time. */
(function (g) {
  'use strict';
  var h = UI.h;
  var PAGE = 200;

  var lineHint = 0;
  Bus.on('editor', function (d) { if (d && d.line) lineHint = d.line; });

  function fmtSize(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

  function stateTone(st) {
    return st === 'SUCCESS' ? 'ok' : st === 'FAILED' ? 'failed' : st === 'RUNNING' ? 'warning' : st === 'CANCELLED' ? 'warning' : st === 'UNCERTAIN' ? 'warning' : 'unknown';
  }
  function stateLabel(st) {
    return st === 'SUCCESS' ? 'done' : st === 'FAILED' ? 'failed' : st === 'RUNNING' ? 'working' : st === 'CANCELLED' ? 'stopped' : st === 'UNCERTAIN' ? 'outcome unknown' : String(st || '').toLowerCase() || 'unknown';
  }

  var Files = {
    view: 'tree',
    expanded: new Set(),
    cache: {},
    shown: {},
    shelfOpen: false,

    reset: function () { Files.view = 'tree'; Files.expanded = new Set(); Files.cache = {}; Files.shown = {}; Files.shelfOpen = false; },
    openPath: function (path) {
      if (!path) return Promise.resolve(false);
      var clean = String(path).replace(/\\/g, '/');
      var projectName = State.project && State.project.id ? State.project.id : '';
      var marker = projectName ? '/' + projectName + '/' : '';
      var absolute = clean.charAt(0) === '/' || /^~\//.test(clean);
      if (absolute && marker) {
        // Agent tools may report either the Termux path or an Android shared-storage path.
        // Only convert an absolute path when it demonstrably belongs to this project's root.
        var at = clean.lastIndexOf(marker);
        var knownRoot = at >= 0 && clean.indexOf('/OpenCodeProjects/' + projectName + '/') >= 0;
        if (knownRoot) clean = clean.slice(at + marker.length);
        else if (clean.indexOf('~/OpenCodeProjects/' + projectName + '/') === 0) clean = clean.slice(('~/OpenCodeProjects/' + projectName + '/').length);
        else {
          UI.toast('This file is outside the selected project workspace. Open Settings → OpenCode and select “Follow open project”, then retry.', 'warn');
          return Promise.resolve(false);
        }
      } else if (/^~\//.test(clean)) {
        UI.toast('Cannot resolve this home-relative path to the selected project.', 'warn');
        return Promise.resolve(false);
      }
      clean = clean.replace(/^\.\//, '').replace(/^\/+/, '');
      if (!clean || clean.split('/').some(function (part) { return part === '..'; })) { UI.toast('This file path is outside the current project.', 'warn'); return Promise.resolve(false); }
      return Editor.open(clean, 0).then(function (tab) {
        if (tab) { Files.view = 'editor'; Router.setTab('files'); Bus.emit('editor'); }
        return !!tab;
      }, function (e) { UI.toast(e.message || 'Could not open file', 'bad'); return false; });
    },

    render: function (el) {
      var cleanup = function () {};

      function draw() {
        cleanup();
        cleanup = function () {};
        el.innerHTML = '';
        if (Files.view === 'editor' && Editor.hasOpen) {
          var box = h('div', { class: 'fill' });
          el.appendChild(box);
          var line = lineHint; lineHint = 0;
          cleanup = Editor.render(box, { line: line, onBack: function () { Files.view = 'tree'; draw(); } });
        } else {
          Files.view = 'tree';
          cleanup = drawTree(el);
        }
      }

      var off = Bus.on('editor', function () {
        if (Files.view === 'editor') draw();
      });
      Files._showTree = function () { Files.view = 'tree'; draw(); };
      draw();
      return function () { cleanup(); off(); Files._showTree = null; };
    }
  };

  function openFile(path, line, redraw) {
    Editor.open(path, line).then(function (tab) {
      if (tab) { Files.view = 'editor'; redraw(); }
    });
  }

  function drawTree(root) {
    var alive = true;
    var query = '';
    var timer = null;
    var list = h('ul', { class: 'tree', role: 'tree' });
    var results = h('ul', { class: 'results' });
    var search = h('input', { class: 'input', type: 'search', placeholder: 'Search files and code', 'aria-label': 'Search files and code', autocapitalize: 'off', enterkeyhint: 'search' });
    var openBtn = h('button', { class: 'btn small open-files', hidden: !Editor.hasOpen, onclick: function () { Files.view = 'editor'; Bus.emit('editor'); } }, 'Open files (' + Editor.tabs.length + ')');
    var rootPath = h('div', { class: 'files-root-path', role: 'status' },
      h('span', { class: 'files-root-label' }, 'Chat directory'),
      h('code', { class: 'files-root-value' }, 'Checking active folder…'));
    var pathValueNode = rootPath.childNodes && rootPath.childNodes.length > 1 ? rootPath.childNodes[1] : null;
    var pathActions = h('div', { class: 'files-path-actions' });
    var refreshBtn = h('button', { class: 'btn small ghost', onclick: function () { refreshAll().then(function () { showActiveWorkspace(); UI.toast('Files refreshed'); }, function (e) { UI.toast(e.message || 'Could not refresh files', 'bad'); }); } }, UI.icon('refresh', 16), ' Refresh');
    var expandBtn = h('button', { class: 'btn small ghost', onclick: expandAllFolders }, 'Expand all folders');
    pathActions.appendChild(refreshBtn);
    pathActions.appendChild(expandBtn);
    var shelf = h('div', { class: 'task-shelf' });
    var wrap = h('div', { class: 'files' },
      h('div', { class: 'files-bar' },
        h('div', { class: 'search-wrap' }, UI.icon('search', 18), search),
        h('button', { class: 'icon-btn', 'aria-label': 'Add file or photo', onclick: addMenu }, UI.icon('plus', 22))),
      h('div', { class: 'files-sub' }, openBtn),
      h('div', { class: 'files-location' }, rootPath, pathActions),
      shelf, list, results);
    root.appendChild(wrap);
    function onImported(data) {
      if (!alive || !data) return;
      if (data.cancelled) return;
      if (data.error) { UI.toast(data.error, 'bad'); return; }
      UI.toast('Imported ' + (data.path || 'file') + ' (' + (data.size || 0) + ' bytes)');
      refreshAll();
      Bus.emit('files');
    }
    Bridge.on('project.file.imported', onImported);

    function showActiveWorkspace() {
      var value = pathValueNode;
      if (!value) return;
      var projectName = State.project && State.project.id ? State.project.id : '';
      var expected = projectName ? '~/OpenCodeProjects/' + projectName : 'No project selected';
      value.textContent = expected;
      if (!Bridge.opencodeGetWorkspace) return;
      Bridge.opencodeGetWorkspace().then(function (w) {
        if (!alive) return;
        var effective = w && (w.effective || w.custom);
        value.textContent = effective || expected;
        rootPath.classList.toggle('files-path-mismatch', !!(effective && projectName && !workspaceMatchesProject(effective, projectName)));
        if (rootPath.classList.contains('files-path-mismatch')) {
          pathActions.innerHTML = '';
          pathActions.appendChild(h('span', { class: 'muted files-path-warning' }, 'Chat folder differs from the Files project folder.'));
          pathActions.appendChild(h('button', { class: 'btn small', onclick: function () {
            Bridge.opencodeSetWorkspace('project').then(function () { return OpenCode.ensure(true); }).then(function () {
              UI.toast('Chat folder aligned with this project'); showActiveWorkspace();
            }, function (e) { UI.toast(e.message || 'Could not align chat folder', 'bad'); });
          } }, 'Use project folder'));
        } else {
          pathActions.innerHTML = '';
          pathActions.appendChild(refreshBtn);
          pathActions.appendChild(expandBtn);
        }
      }, function () { if (alive) value.textContent = expected; });
    }
    function workspaceMatchesProject(path, name) {
      var p = String(path || '').replace(/\\/g, '/').replace(/\/$/, '');
      return p === '~/OpenCodeProjects/' + name || p.endsWith('/OpenCodeProjects/' + name);
    }
    showActiveWorkspace();

    /* Persistent, per-project list of AI tasks; live state comes from the agent, history from local metadata. */
    function taskRow(rec, live) {
      var files = rec.changes || 0;
      var meta = (rec.mode === 'plan' ? 'Plan \u00b7 ' : 'Build \u00b7 ') + (live ? 'working' : stateLabel(rec.state)) + ' \u00b7 ' + UI.timeAgo(rec.at || Date.now()) + (files ? ' \u00b7 ' + files + ' file' + (files > 1 ? 's' : '') : '');
      return h('button', { class: 'task-row', onclick: function () { openTask(rec, live); } },
        UI.dot(live ? 'warning' : stateTone(rec.state)),
        h('span', { class: 'task-text' }, h('strong', null, rec.task || 'Task'), h('span', { class: 'muted task-meta' }, meta)),
        h('span', { class: 'ico-wrap' }, UI.icon('chevron', 18)));
    }

    function openTask(rec, live) {
      var s = UI.sheet({
        title: rec.task || 'SI task',
        body: h('div', { class: 'task-detail' },
          h('p', null, UI.dot(live ? 'warning' : stateTone(rec.state)), ' ', h('strong', null, live ? 'Working' : stateLabel(rec.state)), rec.mode ? h('span', { class: 'muted' }, ' \u00b7 ' + (rec.mode === 'plan' ? 'Plan' : 'Build')) : null),
          h('p', { class: 'muted' }, 'Session ' + rec.id + ' \u00b7 ' + (rec.steps || 0) + ' step(s)' + (rec.changes ? ' \u00b7 ' + rec.changes + ' file(s) changed' : '')),
          rec.snapshot ? null : h('p', { class: 'muted' }, 'No undo snapshot was recorded for this task.')),
        actions: [
          { label: 'Open in SI', kind: 'primary', onClick: function (api) { api.close(); Router.setTab('ai'); Agent.openSession(rec.id); } },
          rec.snapshot && !live ? { label: 'Undo', kind: 'ghost', onClick: function (api) { api.close(); Agent.undoTask(rec.snapshot); } } : null
        ].filter(Boolean)
      });
    }

    function drawShelf() {
      if (!alive) return;
      shelf.innerHTML = '';
      var recs = Agent.taskHistory ? Agent.taskHistory() : [];
      var cur = Agent.session;
      var live = !!(cur && cur.status === 'running');
      var working = Agent.status === 'working' || live;
      var headDot = working ? 'warning' : (recs.length ? stateTone(recs[0].state) : 'unknown');
      shelf.appendChild(h('button', { class: 'task-shelf-head', 'aria-expanded': Files.shelfOpen ? 'true' : 'false', onclick: function () { Files.shelfOpen = !Files.shelfOpen; drawShelf(); } },
        UI.dot(headDot),
        h('strong', null, 'SI tasks'),
        h('span', { class: 'muted task-count' }, working ? 'working' : (recs.length ? recs.length + ' recorded' : 'none yet')),
        h('span', { class: 'ico-wrap task-caret' }, UI.icon('chevron', 18))));
      if (!Files.shelfOpen) return;
      var body = h('div', { class: 'task-list' });
      if (working && cur) body.appendChild(taskRow({ id: cur.id, task: cur.task || 'Task in progress', state: 'RUNNING', mode: cur.mode, at: Date.now(), steps: (cur.steps || []).length, changes: (cur.modified || []).length, snapshot: null }, true));
      recs.forEach(function (r) { if (!(working && cur && r.id === cur.id)) body.appendChild(taskRow(r, false)); });
      if (!body.childNodes.length) body.appendChild(h('p', { class: 'muted task-empty' }, 'No SI tasks recorded for this project yet. Tasks you run are listed here; OpenCode keeps the conversation itself.'));
      shelf.appendChild(body);
    }

    function redrawParent() { root.innerHTML = ''; alive = false; Files.view === 'editor' ? Bus.emit('editor') : null; }

    function load(path) {
      return Bridge.listFiles(path).then(function (items) { Files.cache[path] = items; return items; });
    }

    function flatten(path, depth, out) {
      var items = Files.cache[path] || [];
      var limit = Files.shown[path] || PAGE;
      items.slice(0, limit).forEach(function (it) {
        out.push({ it: it, depth: depth });
        if (it.type === 'dir' && Files.expanded.has(it.path)) flatten(it.path, depth + 1, out);
      });
      if (items.length > limit) out.push({ more: path, left: items.length - limit, depth: depth });
    }

    function drawList() {
      if (!alive) return;
      list.innerHTML = '';
      var rows = [];
      flatten('', 0, rows);
      if (!rows.length) list.appendChild(h('li', { class: 'empty-row' }, 'This project has no files yet. Tap + to create one.'));
      rows.forEach(function (r) {
        if (r.more != null) {
          list.appendChild(h('li', { style: { paddingLeft: (12 + r.depth * 16) + 'px' } },
            h('button', { class: 'btn small ghost', onclick: function () { Files.shown[r.more] = (Files.shown[r.more] || PAGE) + PAGE; drawList(); } }, 'Show ' + Math.min(PAGE, r.left) + ' more')));
          return;
        }
        var it = r.it, isDir = it.type === 'dir', open = Files.expanded.has(it.path);
        list.appendChild(h('li', { class: 'row-item', role: 'treeitem', 'aria-expanded': isDir ? open : null },
          h('button', {
            class: 'row-main', style: { paddingLeft: (12 + r.depth * 16) + 'px' },
            onclick: function () {
              if (!isDir) { openFile(it.path, 0, function () { root.innerHTML = ''; alive = false; Bus.emit('editor'); }); return; }
              if (open) { Files.expanded.delete(it.path); drawList(); }
              else load(it.path).then(function () { Files.expanded.add(it.path); drawList(); }, function (e) { UI.toast(e.message, 'bad'); });
            }
          },
          h('span', { class: 'ico-wrap' }, UI.icon(isDir ? (open ? 'chevron' : 'files') : 'file', 18)),
          h('span', { class: 'row-name' }, it.name + (isDir ? '/' : '')),
          isDir ? null : h('span', { class: 'muted' }, fmtSize(it.size))),
          h('button', { class: 'icon-btn flat', 'aria-label': 'Actions for ' + it.name, onclick: function () { actions(it); } }, UI.icon('more', 20))));
      });
    }

    function expandAllFolders() {
      var visited = 0;
      var maxFolders = 400;
      var maxDepth = 8;
      function visit(path, depth) {
        if (!alive || depth >= maxDepth || visited >= maxFolders) return Promise.resolve();
        return load(path).then(function (items) {
          if (!alive) return;
          Files.shown[path] = items.length;
          var dirs = items.filter(function (it) { return it.type === 'dir'; });
          return dirs.reduce(function (chain, dir) {
            return chain.then(function () {
              if (!alive || visited >= maxFolders) return;
              visited++;
              Files.expanded.add(dir.path);
              return visit(dir.path, depth + 1);
            });
          }, Promise.resolve());
        });
      }
      UI.toast('Loading project folders…');
      visit('', 0).then(function () {
        if (!alive) return;
        drawList();
        if (visited >= maxFolders) UI.toast('Expanded first ' + maxFolders + ' folders. Open remaining folders manually.', 'warn');
        else UI.toast('Project folders expanded');
      }, function (e) { UI.toast(e.message || 'Could not expand folders', 'bad'); });
    }

    function refreshAll() {
      var paths = [''].concat(Array.from(Files.expanded));
      return Promise.all(paths.map(function (p) { return load(p).catch(function () { Files.expanded.delete(p); }); })).then(drawList);
    }

    function actions(it) {
      var s = UI.sheet({
        title: it.path,
        body: h('div', { class: 'action-list' },
          h('button', { class: 'btn', onclick: function () { s.close(); rename(it); } }, 'Rename or move'),
          h('button', { class: 'btn', onclick: function () { s.close(); UI.copy(it.path); } }, 'Copy path'),
          h('button', { class: 'btn danger', onclick: function () { s.close(); remove(it); } }, 'Delete'))
      });
    }
    function rename(it) {
      UI.prompt('Rename or move', 'New path', it.path, 'Rename').then(function (to) {
        if (!to || to === it.path) return;
        Bridge.moveFile(it.path, to).then(function () { Editor.forget(it.path); UI.toast('Renamed'); refreshAll(); Bus.emit('files'); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    }
    function remove(it) {
      UI.confirm('Delete ' + it.name + '?', it.type === 'dir' ? 'The folder and everything in it will be deleted. Tracked files can be restored from Git.' : 'Tracked files can be restored from Git. New files cannot.', 'Delete', true).then(function (ok) {
        if (!ok) return;
        Bridge.deleteFile(it.path).then(function () { Editor.forget(it.path); UI.toast('Deleted'); refreshAll(); Bus.emit('files'); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    }
    function addMenu() {
      UI.sheet({
        title: 'Add to project',
        body: h('div', { class: 'action-list' },
          h('button', { class: 'btn', onclick: function () { Bridge.pickFileForProject().catch(function (e) { UI.toast(e.message || 'Could not open file picker', 'bad'); }); } }, UI.icon('folder', 18), ' Choose file or photo'),
          h('button', { class: 'btn', onclick: newFile }, UI.icon('file', 18), ' Create new file'))
      });
    }
    function newFile() {
      UI.prompt('New file', 'Path, for example src/util.js', '', 'Create').then(function (p) {
        if (!p) return;
        Bridge.createFile(p).then(function () { Bus.emit('files'); refreshAll(); openFile(p, 0, function () { root.innerHTML = ''; alive = false; Bus.emit('editor'); }); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    }

    function runSearch() {
      results.innerHTML = '';
      if (query.length < 2) { list.hidden = false; return; }
      list.hidden = true;
      Bridge.searchFiles(query).then(function (hits) {
        if (!alive || query.length < 2) return;
        results.innerHTML = '';
        if (!hits.length) results.appendChild(h('li', { class: 'empty-row' }, 'No matches for "' + query + '".'));
        hits.forEach(function (hit) {
          results.appendChild(h('li', null, h('button', {
            class: 'hit', onclick: function () { openFile(hit.path, hit.line, function () { root.innerHTML = ''; alive = false; Bus.emit('editor'); }); }
          }, h('span', { class: 'hit-path' }, hit.path + (hit.line ? ':' + hit.line : '')), h('span', { class: 'hit-text' }, hit.text))));
        });
      }, function (e) { UI.toast(e.message, 'bad'); });
    }
    search.addEventListener('input', function () { query = search.value.trim(); clearTimeout(timer); timer = setTimeout(runSearch, 300); });

    load('').then(drawList, function (e) { list.appendChild(h('li', null, UI.errorCard(Errors.classify(e, e.code), []))); });
    var off = Bus.on('files', function () { if (alive) refreshAll(); });
    var offAgent = Bus.on('agent', function () { drawShelf(); });
    drawShelf();
    return function () { alive = false; off(); offAgent(); Bridge.off('project.file.imported', onImported); clearTimeout(timer); };
  }

  g.Files = Files;
})(window);
