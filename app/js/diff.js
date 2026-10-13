/* diff.js — line diff (LCS) for the mock backend / AI review, and a parser for
   real `git diff` output so one renderer serves both. Shape:
   {path, added, removed, lines:[{t:'+'|'-'|' '|'~', s}]} */
(function (g) {
  'use strict';

  function ops(a, b) {
    var n = a.length, m = b.length, i, j;
    var dp = [];
    for (i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
      else out.push(['+', b[j++]]);
    }
    while (i < n) out.push(['-', a[i++]]);
    while (j < m) out.push(['+', b[j++]]);
    return out;
  }

  function diffFile(path, oldText, newText, ctx) {
    ctx = ctx == null ? 2 : ctx;
    var a = oldText == null ? [] : oldText.split('\n');
    var b = newText == null ? [] : newText.split('\n');
    if (a.length * b.length > 4e6) {
      return { path: path, added: b.length, removed: a.length, big: true, lines: [{ t: '~', s: 'File too large for an inline diff' }] };
    }
    var list = ops(a, b), added = 0, removed = 0;
    list.forEach(function (o) { if (o[0] === '+') added++; else if (o[0] === '-') removed++; });
    var keep = new Array(list.length).fill(false);
    list.forEach(function (o, i) {
      if (o[0] === ' ') return;
      for (var k = Math.max(0, i - ctx); k <= Math.min(list.length - 1, i + ctx); k++) keep[k] = true;
    });
    var lines = [], gap = false;
    list.forEach(function (o, i) {
      if (keep[i]) {
        if (gap && lines.length) lines.push({ t: '~', s: '⋯' });
        gap = false;
        lines.push({ t: o[0], s: o[1] });
      } else gap = true;
    });
    return { path: path, added: added, removed: removed, lines: lines };
  }

  function parseUnified(text) {
    var files = [], cur = null;
    String(text || '').split('\n').forEach(function (l) {
      if (l.indexOf('diff --git') === 0) {
        var m = l.match(/ b\/(.+)$/);
        cur = { path: m ? m[1] : '?', added: 0, removed: 0, lines: [] };
        files.push(cur);
        return;
      }
      if (!cur) return;
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) return;
      if (l.indexOf('@@') === 0) { cur.lines.push({ t: '~', s: l }); return; }
      var c = l.charAt(0);
      if (c === '+') { cur.added++; cur.lines.push({ t: '+', s: l.slice(1) }); }
      else if (c === '-') { cur.removed++; cur.lines.push({ t: '-', s: l.slice(1) }); }
      else if (c === ' ') cur.lines.push({ t: ' ', s: l.slice(1) });
    });
    return files;
  }

  g.Diff = { diffFile: diffFile, parseUnified: parseUnified };
})(window);
