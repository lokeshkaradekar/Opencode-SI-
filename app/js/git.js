/* git.js — Git service + screen: branch, changes, diff, commit, log.
   Destructive operations (discard) always ask first; history is never rewritten here. */
(function (g) {
  'use strict';
  var h = UI.h;

  var Git = {
    status: function () { return Bridge.gitStatus(); },
    diff: function (path) {
      return Bridge.gitDiff(path).then(function (r) { return Diff.parseUnified(r.text); });
    },
    commit: function (msg) { return Bridge.gitCommit(msg); },
    log: function () { return Bridge.gitLog(); },
    restore: function (path) { return Bridge.gitRestore(path); },

    renderDiff: function (d, note) {
      var rows = d.lines.map(function (l) {
        return h('div', { class: 'dl dl-' + (l.t === '+' ? 'add' : l.t === '-' ? 'rem' : l.t === '~' ? 'gap' : 'ctx') },
          h('span', { class: 'dl-sign' }, l.t === '~' ? '' : l.t === ' ' ? '' : l.t),
          h('span', { class: 'dl-text' }, l.s || ' '));
      });
      return h('section', { class: 'diff' },
        h('header', { class: 'diff-head' },
          h('code', null, d.path), note ? h('span', { class: 'muted' }, note) : null,
          h('span', { class: 'stat' }, h('span', { class: 'add' }, '+' + d.added), ' ', h('span', { class: 'rem' }, '\u2212' + d.removed))),
        h('div', { class: 'diff-body' }, rows.length ? rows : h('div', { class: 'dl dl-gap' }, 'No textual changes'))
      );
    }
  };

  var CODE_LABEL = { M: 'Modified', '?': 'New', D: 'Deleted', A: 'Added' };

  function render(el) {
    var alive = true;
    var branchEl = h('span', { class: 'chip' }, 'main');
    var changes = h('ul', { class: 'git-changes panel' });
    var logEl = h('ul', { class: 'plain git-log' });
    var msg = h('input', { class: 'input', type: 'text', placeholder: 'Commit message', 'aria-label': 'Commit message', enterkeyhint: 'done' });
    var commitBtn = h('button', { class: 'btn primary' }, 'Commit all');
    var summary = h('p', { class: 'muted' });
    var syncRow = h('div', { class: 'row wrap' });

    function load() {
      Git.status().then(function (st) {
        if (!alive) return;
        branchEl.textContent = '\u2387 ' + st.branch;
        changes.innerHTML = '';
        summary.textContent = st.files.length ? st.files.length + ' file' + (st.files.length > 1 ? 's' : '') + ' with changes' : 'Working tree clean';
        commitBtn.disabled = !st.files.length;
        if (!st.files.length) changes.appendChild(h('li', { class: 'empty-row' }, 'Nothing to commit. Changes from the agent or editor appear here.'));
        st.files.forEach(function (f) {
          changes.appendChild(h('li', { class: 'change' },
            h('button', { class: 'change-main', onclick: function () { showDiff(f.path); } },
              h('span', { class: 'code code-' + (f.code === '?' ? 'new' : f.code) }, f.code),
              h('span', { class: 'change-path' }, f.path),
              h('span', { class: 'muted' }, CODE_LABEL[f.code] || '')),
            h('button', { class: 'btn small ghost', onclick: function () { discard(f); } }, f.code === '?' ? 'Delete' : 'Discard')));
        });
      }, function (e) { if (alive) changes.replaceChildren(h('li', null, UI.errorCard(Errors.classify(e, e.code), []))); });
      Git.log().then(function (list) {
        if (!alive) return;
        logEl.innerHTML = '';
        list.slice(0, 6).forEach(function (l) {
          logEl.appendChild(h('li', { class: 'logrow' }, h('code', null, l.hash), h('span', { class: 'log-msg' }, l.msg), h('span', { class: 'muted' }, UI.timeAgo(l.at))));
        });
      }, function () { /* ignore */ });
    }

    function showDiff(path) {
      Git.diff(path).then(function (files) {
        var body = h('div', { class: 'review' }, files.length ? files.map(function (d) { return Git.renderDiff(d); }) : h('p', { class: 'muted' }, 'No changes in this file.'));
        UI.sheet({ title: 'Changes', body: body });
      }, function (e) { UI.toast(e.message, 'bad'); });
    }

    function discard(f) {
      var verb = f.code === '?' ? 'Delete' : 'Discard changes to';
      UI.confirm(verb + ' ' + f.path + '?', f.code === '?' ? 'This file is not tracked by Git, so it cannot be recovered afterwards.' : 'Your edits to this file will be replaced with the last committed version.', f.code === '?' ? 'Delete' : 'Discard', true).then(function (ok) {
        if (!ok) return;
        Git.restore(f.path).then(function () { UI.toast('Done'); Bus.emit('files'); load(); }, function (e) { UI.toast(e.message, 'bad'); });
      });
    }

    commitBtn.addEventListener('click', function () {
      var m = msg.value.trim();
      if (!m) { UI.toast('Write a commit message first', 'bad'); msg.focus(); return; }
      commitBtn.disabled = true;
      Git.commit(m).then(function (r) { msg.value = ''; UI.toast('Committed ' + r.hash); load(); }, function (e) {
        UI.toast(Errors.classify(e, e.code).title, 'bad'); load();
      });
    });

    ['fetch', 'pull', 'push'].forEach(function (op) {
      syncRow.appendChild(h('button', { class: 'btn small', onclick: function () {
        Bridge.gitOp(op).then(function (r) { UI.toast((r.output || op + ' done').trim().split('\n')[0]); load(); }, function (e) { UI.toast(e.message, 'bad'); load(); });
      } }, op));
    });

    el.appendChild(h('div', { class: 'scroll-pad' },
      h('div', { class: 'git-top' }, branchEl, summary),
      changes,
      h('section', { class: 'panel' },
        h('h3', { class: 'h3' }, 'Commit'),
        h('label', { class: 'field' }, h('span', null, 'Message'), msg),
        h('div', { class: 'row' }, commitBtn)),
      h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Sync'), syncRow, h('p', { class: 'muted' }, 'Force-push and hard resets are never run without your review.')),
      h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'History'), logEl)
    ));
    load();
    var off = Bus.on('files', load);
    return function () { alive = false; off(); };
  }

  Git.render = render;
  g.Git = Git;
})(window);
