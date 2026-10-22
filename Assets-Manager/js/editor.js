/* editor.js — touch-friendly code editor (Phase 18).
   Tabs, line numbers, syntax highlighting (overlay technique), find/replace,
   undo/redo, autosave, large-file handling. No external libraries. */
(function (g) {
  'use strict';
  var h = UI.h;

  var LINE_H = 20;
  var HL_LIMIT = 150000;     // above this: plain text, no highlighting
  var SAVE_DELAY = 800;
  var HIST_DELAY = 400;

  var tabs = [];
  var active = null;         // path
  var projectKey = null;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var JS_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|class|new|require|module|exports|throw|import|from|export|async|await|try|catch|this|null|undefined|true|false|typeof|of|in)\b|\b(\d+(?:\.\d+)?)\b/g;
  var JSON_RE = /("(?:\\.|[^"\\\n])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g;
  var MD_RE = /^(#{1,6}\s.*)$|(`[^`\n]+`)/gm;
  var CSS_RE = /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw)?)/g;

  function tokenize(text, re, classes) {
    re.lastIndex = 0;
    var out = '', last = 0, m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index));
      var idx = -1;
      for (var i = 1; i < m.length; i++) if (m[i] != null) { idx = i - 1; break; }
      var cls = classes[idx];
      out += cls ? '<span class="t-' + cls + '">' + esc(m[0]) + '</span>' : esc(m[0]);
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function highlight(text, path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    if (/^(js|mjs|cjs|jsx|ts|tsx|java|kt)$/.test(ext)) return tokenize(text, JS_RE, ['c', 's', 'k', 'n']);
    if (ext === 'json') return tokenize(text, JSON_RE, ['s', 'k', 'n']);
    if (ext === 'md') return tokenize(text, MD_RE, ['k', 's']);
    if (/^(css|scss)$/.test(ext)) return tokenize(text, CSS_RE, ['c', 's', 'n']);
    return esc(text);
  }

  function find(path) { return tabs.filter(function (t) { return t.path === path; })[0]; }
  function current() { return find(active); }
  function persistTabs() { if (projectKey) Persist.set('tabs:' + projectKey, { paths: tabs.map(function (t) { return t.path; }), active: active }); }

  var Editor = {
    get tabs() { return tabs; },
    get hasOpen() { return tabs.length > 0; },

    reset: function (key) {
      Editor.flush();
      tabs = []; active = null; projectKey = key;
    },

    /* Reopen the tabs that were open last time in this project. */
    restore: function (key) {
      Editor.reset(key);
      var saved = Persist.get('tabs:' + key, null);
      if (!saved || !saved.paths) return Promise.resolve();
      return saved.paths.reduce(function (chain, p) {
        return chain.then(function () { return Editor.open(p, 0, true); });
      }, Promise.resolve()).then(function () { if (saved.active && find(saved.active)) active = saved.active; Bus.emit('editor'); });
    },

    open: function (path, line, quiet) {
      var t = find(path);
      if (t) { active = path; persistTabs(); Bus.emit('editor', { line: line }); return Promise.resolve(t); }
      return Bridge.readFile(path).then(function (r) {
        var tab = { path: path, content: r.content, saved: r.content, hist: [r.content], hi: 0, status: 'saved', big: r.content.length > HL_LIMIT, timer: null, histTimer: null };
        tabs.push(tab);
        active = path;
        persistTabs();
        if (!quiet) Bus.emit('editor', { line: line });
        return tab;
      }, function (e) {
        if (!quiet) UI.toast(Errors.classify(e, e.code).title + ' \u2014 ' + e.message, 'bad');
        return null;
      });
    },

    close: function (path) {
      var t = find(path);
      if (!t) return Promise.resolve();
      var done = function () {
        clearTimeout(t.timer); clearTimeout(t.histTimer);
        var i = tabs.indexOf(t);
        tabs.splice(i, 1);
        if (active === path) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)].path : null;
        persistTabs();
        Bus.emit('editor');
      };
      if (t.content !== t.saved) {
        return Editor.save(t).then(function () {
          if (t.content !== t.saved) return UI.confirm('Close without saving?', 'This file could not be saved. Closing will lose your latest edits.', 'Close', true).then(function (ok) { if (ok) done(); });
          done();
        });
      }
      done();
      return Promise.resolve();
    },

    /* After a rename/delete elsewhere, drop tabs for paths that no longer exist. */
    forget: function (prefix) {
      tabs = tabs.filter(function (t) { return !(t.path === prefix || t.path.indexOf(prefix + '/') === 0); });
      if (!find(active)) active = tabs.length ? tabs[0].path : null;
      persistTabs();
      Bus.emit('editor');
    },

    /* Reload tabs from disk when something else (agent, undo, git) changed files. */
    refresh: function () {
      return Promise.all(tabs.map(function (t) {
        if (t.content !== t.saved) return null;     // never overwrite unsaved edits
        return Bridge.readFile(t.path).then(function (r) {
          if (r.content !== t.content) { t.content = t.saved = r.content; t.hist = [r.content]; t.hi = 0; }
        }, function () {});
      })).then(function () { Bus.emit('editor'); });
    },

    save: function (t) {
      t = t || current();
      if (!t || t.content === t.saved) return Promise.resolve();
      clearTimeout(t.timer);
      var snapshot = t.content;
      t.status = 'saving';
      Bus.emit('editor:status', t);
      return Bridge.writeFile(t.path, snapshot).then(function () {
        t.saved = snapshot;
        t.status = t.content === snapshot ? 'saved' : 'dirty';
        Bus.emit('editor:status', t);
        Bus.emit('files:changed');
      }, function (e) {
        t.status = 'error';
        Bus.emit('editor:status', t);
        UI.toast('Could not save ' + t.path + ': ' + Errors.classify(e, e.code).title, 'bad');
      });
    },

    flush: function () { return Promise.all(tabs.map(function (t) { return Editor.save(t); })); },

    render: function (el, opts) {
      opts = opts || {};
      var t = current();
      el.innerHTML = '';
      if (!t) { el.appendChild(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'No file open. Pick one from the file list.'))); return function () {}; }

      var ta = h('textarea', { class: 'ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'aria-label': 'Editing ' + t.path });
      var pre = h('pre', { class: 'hl', 'aria-hidden': 'true' });
      var gutter = h('div', { class: 'gutter', 'aria-hidden': 'true' });
      var gutterInner = h('div', { class: 'gutter-inner' });
      var statusEl = h('span', { class: 'ed-status' });
      var findInput = h('input', { class: 'input small', type: 'text', placeholder: 'Find', 'aria-label': 'Find', autocapitalize: 'off' });
      var replInput = h('input', { class: 'input small', type: 'text', placeholder: 'Replace', 'aria-label': 'Replace', autocapitalize: 'off' });
      var findBar = h('div', { class: 'findbar', hidden: true });
      var lineCount = 0;

      ta.value = t.content;
      if (t.big) { el.classList.add('plain'); } else el.classList.remove('plain');

      function paint() {
        var text = ta.value;
        if (!t.big) pre.innerHTML = highlight(text, t.path) + '\n';
        var n = text.split('\n').length;
        if (n !== lineCount) {
          lineCount = n;
          var s = '';
          for (var i = 1; i <= n; i++) s += i + '\n';
          gutterInner.textContent = s;
        }
        syncScroll();
      }
      function syncScroll() {
        var tr = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
        pre.style.transform = tr;
        gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
      }
      function setStatus(tab) {
        if (tab.path !== t.path) return;
        var map = { saved: 'Saved', saving: 'Saving\u2026', dirty: 'Unsaved', error: 'Not saved' };
        statusEl.textContent = map[tab.status] || '';
        statusEl.className = 'ed-status ' + tab.status;
        var dirtyDot = el.querySelector('.tab.active .dirty');
        if (dirtyDot) dirtyDot.hidden = tab.content === tab.saved;
      }
      function pushHistory() {
        if (t.hist[t.hi] === t.content) return;
        t.hist = t.hist.slice(0, t.hi + 1);
        t.hist.push(t.content);
        if (t.hist.length > 100) t.hist.shift();
        t.hi = t.hist.length - 1;
      }
      function changed() {
        t.content = ta.value;
        t.status = t.content === t.saved ? 'saved' : 'dirty';
        paint();
        setStatus(t);
        clearTimeout(t.histTimer);
        t.histTimer = setTimeout(pushHistory, HIST_DELAY);
        clearTimeout(t.timer);
        t.timer = setTimeout(function () { Editor.save(t); }, SAVE_DELAY);
      }
      function setValue(v) { ta.value = v; changed(); }
      function undo() {
        clearTimeout(t.histTimer); pushHistory();
        if (t.hi > 0) { t.hi--; setValue(t.hist[t.hi]); }
      }
      function redo() { if (t.hi < t.hist.length - 1) { t.hi++; setValue(t.hist[t.hi]); } }

      function gotoLine(line) {
        if (!line) return;
        var idx = 0, v = ta.value, n = 1;
        while (n < line && idx >= 0) { idx = v.indexOf('\n', idx); if (idx >= 0) { idx++; n++; } }
        if (idx < 0) return;
        ta.scrollTop = Math.max(0, (line - 4) * LINE_H);
        ta.setSelectionRange(idx, v.indexOf('\n', idx) < 0 ? v.length : v.indexOf('\n', idx));
        syncScroll();
      }

      function findNext(dir) {
        var q = findInput.value, v = ta.value;
        if (!q) return;
        var idx = dir > 0 ? v.indexOf(q, ta.selectionEnd) : v.lastIndexOf(q, Math.max(0, ta.selectionStart - 1));
        if (idx < 0) idx = dir > 0 ? v.indexOf(q) : v.lastIndexOf(q);
        if (idx < 0) { UI.toast('No matches'); return; }
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(idx, idx + q.length);
        var line = v.slice(0, idx).split('\n').length;
        ta.scrollTop = Math.max(0, (line - 4) * LINE_H);
        syncScroll();
      }
      function replaceOne() {
        var q = findInput.value;
        if (!q) return;
        if (ta.value.slice(ta.selectionStart, ta.selectionEnd) === q) {
          ta.setRangeText(replInput.value, ta.selectionStart, ta.selectionEnd, 'end');
          changed();
        }
        findNext(1);
      }
      function replaceAll() {
        var q = findInput.value;
        if (!q) return;
        var parts = ta.value.split(q);
        if (parts.length < 2) { UI.toast('No matches'); return; }
        setValue(parts.join(replInput.value));
        UI.toast('Replaced ' + (parts.length - 1));
      }

      findBar.appendChild(h('div', { class: 'find-row' }, findInput,
        h('button', { class: 'btn small', onclick: function () { findNext(-1); }, 'aria-label': 'Previous match' }, 'Prev'),
        h('button', { class: 'btn small', onclick: function () { findNext(1); }, 'aria-label': 'Next match' }, 'Next')));
      findBar.appendChild(h('div', { class: 'find-row' }, replInput,
        h('button', { class: 'btn small', onclick: replaceOne }, 'Replace'),
        h('button', { class: 'btn small', onclick: replaceAll }, 'All')));
      findInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); findNext(1); } });

      ta.addEventListener('input', changed);
      ta.addEventListener('scroll', syncScroll);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); changed(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); Editor.save(t); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); findBar.hidden = false; findInput.focus(); }
        else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
        else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
      });

      var tabStrip = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (tb) {
        var name = tb.path.split('/').pop();
        return h('div', { class: 'tab' + (tb.path === active ? ' active' : ''), role: 'tab', 'aria-selected': tb.path === active },
          h('button', { class: 'tab-main', onclick: function () { if (tb.path !== active) { Editor.flush(); active = tb.path; persistTabs(); Bus.emit('editor'); } } },
            name, h('span', { class: 'dirty', hidden: tb.content === tb.saved, 'aria-label': 'unsaved' }, '\u25cf')),
          h('button', { class: 'tab-x', 'aria-label': 'Close ' + name, onclick: function () { Editor.close(tb.path); } }, UI.icon('x', 14)));
      }));

      var bar = h('div', { class: 'ed-bar' },
        h('button', { class: 'btn small ghost', onclick: function () { Editor.flush(); if (opts.onBack) opts.onBack(); } }, UI.icon('back', 18), 'Files'),
        h('span', { class: 'ed-path' }, t.path),
        statusEl,
        h('button', { class: 'icon-btn flat', 'aria-label': 'Undo', onclick: undo }, UI.icon('undo', 20)),
        h('button', { class: 'icon-btn flat flip', 'aria-label': 'Redo', onclick: redo }, UI.icon('undo', 20)),
        h('button', { class: 'icon-btn flat', 'aria-label': 'Find and replace', onclick: function () { findBar.hidden = !findBar.hidden; if (!findBar.hidden) findInput.focus(); } }, UI.icon('search', 20)));

      el.appendChild(h('div', { class: 'editor' },
        tabStrip, bar, findBar,
        t.big ? h('p', { class: 'note' }, 'Large file: highlighting is off to keep the app fast.') : null,
        h('div', { class: 'ed-view' }, gutter, h('div', { class: 'code-wrap' }, pre, ta))));
      gutter.appendChild(gutterInner);
      paint();
      setStatus(t);
      if (opts.line) setTimeout(function () { gotoLine(opts.line); }, 30);

      var offStatus = Bus.on('editor:status', setStatus);
      var strip = tabStrip.querySelector('.tab.active');
      if (strip && strip.scrollIntoView) strip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      return function () { offStatus(); };
    }
  };

  g.Editor = Editor;
})(window);
