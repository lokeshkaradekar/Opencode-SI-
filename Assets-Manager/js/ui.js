/* ui.js — tiny DOM toolkit: h(), icons, toast, bottom sheets, confirm/prompt. */
(function (g) {
  'use strict';

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    var kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (c) {
        if (c == null || c === false) return;
        if (Array.isArray(c)) return add(c);
        el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
      });
    })(kids);
    return el;
  }

  var ICONS = {
    ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z"/>',
    files: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    terminal: '<path d="M4 6l6 6-6 6"/><path d="M13 18h7"/>',
    git: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11c0 4-6 3-12 5"/>',
    health: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    gear: '<path d="M19.4 13.5c.04-.33.06-.66.06-1s-.02-.67-.06-1l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.4 7.4 0 00-1.73-1l-.36-2.54a.5.5 0 00-.5-.43h-3.84a.5.5 0 00-.5.43l-.36 2.54a7.4 7.4 0 00-1.73 1l-2.39-.96a.5.5 0 00-.6.22L2.65 9.28a.5.5 0 00.12.64L4.8 11.5c-.04.33-.06.66-.06 1s.02.67.06 1l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.23.4.32.6.22l2.39-.96c.53.43 1.1.77 1.73 1l.36 2.54c.05.25.26.43.5.43h3.84c.25 0 .45-.18.5-.43l.36-2.54a7.4 7.4 0 001.73-1l2.39.96c.23.1.5 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64L19.4 13.5z"/><circle cx="12" cy="12" r="3.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    send: '<path d="M4 12l16-8-6 16-2-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
    undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 8"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    pulse: '<path d="M3 12h4l2 8 4-16 2 8h6"/>',
    refresh: '<path d="M4 4v5h5M20 20v-5h-5M4 9a9 9 0 0115-6M20 15a9 9 0 01-15 6"/>',
    android: '<rect x="7" y="7" width="10" height="12" rx="2"/><path d="M9 3l1.5 2M15 3l-1.5 2M9 20v2M15 20v2M5 10H3M21 10h-2"/>',
    shell: '<path d="M4 6l6 6-6 6"/><path d="M13 18h7"/>',
    node: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/>',
    folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
    disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    wifi: '<path d="M4 9a13 13 0 0116 0M7 12.5a8.5 8.5 0 0110 0M10 16a4 4 0 014 0"/><circle cx="12" cy="19" r="1"/>',
    report: '<path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/>',
    dehaze: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    link: '<rect x="3" y="2" width="12" height="18" rx="2"/><path d="M7.5 5h3"/><path d="M16.3 13.3a2.4 2.4 0 013.4 0l1 1a2.4 2.4 0 01-3.4 3.4l-.5-.5M18.7 14.7l-4 4"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    termgear: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 9l3 2-3 2M12 13h3"/><circle cx="18" cy="20" r="2.2"/><path d="M18 17v.4M18 22.6v.4M15.4 20h.4M20.2 20h.4M16.2 17.8l.3.3M19.5 21.1l.3.3M19.8 17.8l-.3.3M16.5 21.1l-.3.3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2.5 2.5M14 9l2 2"/>',
    pin: '<path d="M12 2a6 6 0 00-6 6c0 4.5 6 12 6 12s6-7.5 6-12a6 6 0 00-6-6z"/><circle cx="12" cy="8" r="2.2"/>',
    edit: '<path d="M4 20l1-4.2L15.6 5.2a1.5 1.5 0 012.1 0l1.1 1.1a1.5 1.5 0 010 2.1L8.2 19l-4.2 1z"/><path d="M14 7l3 3"/>'
  };
  function icon(name, size) {
    var s = size || 22;
    var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', s);
    el.setAttribute('height', s);
    el.setAttribute('class', 'ico ico-' + name);
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ICONS[name] || '';
    return el;
  }

  function dot(status) {
    return h('span', { class: 'dot dot-' + (status || 'unknown'), 'aria-label': status || 'unknown' });
  }

  function timeAgo(ts) {
    var s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function layer() { return document.getElementById('layer'); }

  var toastTimer = null;
  function toast(msg, kind) {
    var old = layer().querySelector('.toast');
    if (old) old.remove();
    var t = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, msg);
    layer().appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 2600);
  }

  var sheets = [];
  /* sheet({title, body: Node, actions: [{label, kind, onClick}]}) -> {close} */
  function sheet(opts) {
    var closed = false;
    var back = h('div', { class: 'sheet-back', onclick: function () { api.close(); } });
    var actions = (opts.actions || []).map(function (a) {
      return h('button', {
        class: 'btn ' + (a.kind || ''),
        onclick: function () {
          var r = a.onClick ? a.onClick(api) : null;
          if (a.keepOpen) return;
          Promise.resolve(r).then(function () { api.close(); });
        }
      }, a.label);
    });
    var panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || '' },
      h('div', { class: 'sheet-grip' }),
      opts.title ? h('h2', { class: 'sheet-title' }, opts.title) : null,
      h('div', { class: 'sheet-body' }, opts.body),
      actions.length ? h('div', { class: 'sheet-actions' }, actions) : null
    );
    var wrap = h('div', { class: 'sheet-wrap' }, back, panel);
    var api = {
      el: wrap,
      close: function () {
        if (closed) return;
        closed = true;
        sheets = sheets.filter(function (s) { return s !== api; });
        wrap.remove();
        if (opts.onClose) opts.onClose();
      }
    };
    sheets.push(api);
    layer().appendChild(wrap);
    return api;
  }
  function closeTopSheet() {
    var s = sheets[sheets.length - 1];
    if (!s) return false;
    s.close();
    return true;
  }

  function confirm(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      sheet({
        title: title,
        body: h('p', { class: 'sheet-text' }, message),
        onClose: function () { fin(false); },
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: function () { fin(false); } },
          { label: okLabel || 'Continue', kind: danger ? 'danger' : 'primary', onClick: function () { fin(true); } }
        ]
      });
    });
  }

  function prompt(title, label, value, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      var input = h('input', { class: 'input', type: 'text', value: value || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
      var s = sheet({
        title: title,
        body: h('label', { class: 'field' }, h('span', null, label), input),
        onClose: function () { fin(null); },
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: function () { fin(null); } },
          { label: okLabel || 'OK', kind: 'primary', onClick: function () { fin(input.value.trim() || null); } }
        ]
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { fin(input.value.trim() || null); s.close(); }
      });
      setTimeout(function () { input.focus(); input.select(); }, 60);
    });
  }

  function copy(text) {
    function fallback() {
      var ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed', 'bad'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, fallback);
    } else fallback();
  }

  /* Error card: simple explanation + technical details, per the plan. */
  function errorCard(err, actions) {
    var details = h('pre', { class: 'err-tech' }, err.technical || '');
    var detailsWrap = h('details', { class: 'err-more' },
      h('summary', null, 'Technical details'),
      err.causes && err.causes.length ? h('ul', { class: 'err-causes' }, err.causes.map(function (c) { return h('li', null, c); })) : null,
      details,
      h('button', { class: 'btn small ghost', onclick: function () { copy(err.technical || ''); } }, 'Copy details')
    );
    return h('div', { class: 'err-card domain-' + err.domain, role: 'alert' },
      h('div', { class: 'err-head' },
        h('span', { class: 'err-cat' }, err.category),
        h('span', { class: 'err-domain' }, err.domain + ' error')
      ),
      h('h3', { class: 'err-title' }, err.title),
      h('p', { class: 'err-simple' }, err.simple),
      err.projectSafe ? h('p', { class: 'err-safe' }, 'Your project files are safe.') : null,
      detailsWrap,
      actions && actions.length ? h('div', { class: 'err-actions' }, actions) : null
    );
  }

  g.UI = {
    h: h, icon: icon, dot: dot, timeAgo: timeAgo, toast: toast, sheet: sheet,
    closeTopSheet: closeTopSheet, confirm: confirm, prompt: prompt, copy: copy,
    errorCard: errorCard, sheetsOpen: function () { return sheets.length > 0; }
  };
})(window);
