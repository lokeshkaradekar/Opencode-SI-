/* router.js — screens (home | settings | project), project tabs, topbar,
   bottom navigation, and Android back-button handling. */
(function (g) {
  'use strict';
  var h = UI.h;

  var TABS = [
    { id: 'ai', label: 'SI', icon: 'ai' },
    { id: 'files', label: 'Files', icon: 'files' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    { id: 'git', label: 'Git', icon: 'git' },
    { id: 'health', label: 'Health', icon: 'health' }
  ];

  var cleanup = null;
  var settingsFrom = 'home';
  var supportFrom = 'home';

  function $(id) { return document.getElementById(id); }

  /* Single menu entry point (the dehaze icon) for every screen: project sections (same destinations as the
     bottom tab bar, useful when that bar is hidden), Settings, and — inside a project — All projects. */
  function openMenu() {
    var inProject = State.screen === 'project';
    var items = [];
    if (inProject) {
      TABS.forEach(function (t) {
        items.push(h('button', {
          class: 'menu-item' + (State.tab === t.id ? ' on' : ''),
          onclick: function () { s.close(); Router.setTab(t.id); }
        }, h('span', { class: 'ico-wrap' }, UI.icon(t.icon, 20)), t.label));
      });
      items.push(h('div', { class: 'menu-sep' }));
      items.push(h('button', { class: 'menu-item', onclick: function () { s.close(); Router.back(true); } },
        h('span', { class: 'ico-wrap' }, UI.icon('back', 20)), 'All projects'));
    }
    items.push(h('div', { class: 'menu-sep' }));
    items.push(h('button', { class: 'menu-item', onclick: function () { s.close(); Router.go('help'); } },
      h('span', { class: 'ico-wrap' }, UI.icon('report', 20)), 'Help & FAQ'));
    items.push(h('button', { class: 'menu-item', onclick: function () { s.close(); Router.go('contact'); } },
      h('span', { class: 'ico-wrap' }, UI.icon('link', 20)), 'Contact & feedback'));
    items.push(h('button', { class: 'menu-item', onclick: function () { s.close(); Router.go('settings'); } },
      h('span', { class: 'ico-wrap' }, UI.icon('gear', 20)), 'Settings'));
    var s = UI.sheet({ title: inProject && State.project ? State.project.name : 'Menu', body: h('div', { class: 'menu-list' }, items) });
  }

  function drawTopbar() {
    var bar = $('topbar');
    bar.innerHTML = '';
    bar.className = 'h-' + (State.health.status || 'unknown');
    var s = State.screen;
    if (s === 'home') {
      bar.appendChild(h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: openMenu }, UI.icon('dehaze')));
      bar.appendChild(h('h1', { class: 'title' }, 'Projects'));
      bar.appendChild(h('span', { class: 'spacer' }));
    } else if (s === 'settings' || s === 'help' || s === 'contact') {
      bar.appendChild(h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: function () { Router.back(); } }, UI.icon('back')));
      bar.appendChild(h('h1', { class: 'title' }, s === 'settings' ? 'Settings' : (s === 'help' ? 'Help & FAQ' : 'Contact & feedback')));
    } else {
      bar.appendChild(h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: openMenu }, UI.icon('dehaze')));
      bar.appendChild(h('div', { class: 'title-block' },
        h('h1', { class: 'title' }, State.project ? State.project.name : ''),
        h('span', { class: 'subtitle' }, (State.backend === 'remote' ? 'Remote workspace' : 'Termux') + ' \u00b7 OpenCode ' + OpenCode.label())));
      bar.appendChild(h('span', { class: 'spacer' }));
      bar.appendChild(h('button', {
        class: 'chip chip-btn', 'aria-label': 'Environment health: ' + State.health.status,
        onclick: function () { Router.setTab('health'); }
      }, UI.dot(State.health.status === 'warning' ? 'warning' : State.health.status), State.health.status === 'ok' ? 'Healthy' : State.health.status === 'unknown' ? 'Checking' : 'Needs attention'));
    }
  }

  function drawTabbar() {
    var nav = $('tabbar');
    nav.innerHTML = '';
    nav.hidden = State.screen !== 'project';
    document.getElementById('app').classList.toggle('no-tabs', nav.hidden);
    if (nav.hidden) return;
    TABS.forEach(function (t) {
      var badge = null;
      if (t.id === 'ai' && Agent.canResume) badge = h('span', { class: 'badge' });
      if (t.id === 'health' && State.health.status !== 'ok' && State.health.status !== 'unknown') badge = h('span', { class: 'badge ' + (State.health.status === 'failed' ? 'bad' : 'warn') });
      nav.appendChild(h('button', {
        class: 'tab-btn' + (State.tab === t.id ? ' active' : ''), 'aria-current': State.tab === t.id ? 'page' : null,
        onclick: function () { Router.setTab(t.id); }
      }, h('span', { class: 'tab-ico' }, UI.icon(t.icon, 22), badge), h('span', null, t.label)));
    });
  }

  var Router = {
    TABS: TABS,

    render: function () {
      if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
      var el = $('screen');
      el.innerHTML = '';
      drawTopbar();
      drawTabbar();
      var fixed = State.screen === 'project' && (State.tab === 'ai' || State.tab === 'files' || State.tab === 'terminal');
      el.className = fixed ? 'fixed' : 'scroll';
      var fn;
      if (State.screen === 'home') fn = App.home;
      else if (State.screen === 'settings') fn = App.settings;
      else if (State.screen === 'help') fn = App.help;
      else if (State.screen === 'contact') fn = App.contact;
      else fn = ({ ai: Agent.render, files: Files.render, terminal: Terminal.render, git: Git.render, health: Health.render })[State.tab];
      try { cleanup = fn(el) || null; }
      catch (e) { console.error(e); el.appendChild(h('div', { class: 'panel' }, 'Something went wrong drawing this screen: ' + e.message)); }
      el.scrollTop = 0;
    },

    go: function (screen) {
      if (screen === 'settings') settingsFrom = State.screen === 'settings' ? settingsFrom : State.screen;
      if (screen === 'help' || screen === 'contact') supportFrom = (State.screen === 'help' || State.screen === 'contact') ? supportFrom : State.screen;
      Editor.flush();
      State.set({ screen: screen });
      Router.render();
    },

    setTab: function (tab) {
      Editor.flush();
      State.set({ screen: 'project', tab: tab });
      Router.render();
    },

    refresh: function () {
      // Rebuild the active view so project lists, task history, file trees and diagnostics
      // are re-read from their real sources without restarting the Android app.
      Editor.flush();
      Router.render();
      var checks = [];
      if (typeof OpenCode !== 'undefined' && OpenCode.ensure) checks.push(OpenCode.ensure(true));
      if (typeof Health !== 'undefined' && Health.run) checks.push(Health.run({ silent: true }));
      return Promise.all(checks.map(function (p) { return Promise.resolve(p).catch(function () {}); }));
    },

    /* Returns true when the app handled "back"; false lets Android close the app. */
    back: function (force) {
      if (UI.closeTopSheet()) return true;
      if (State.screen === 'settings') { State.set({ screen: settingsFrom || 'home' }); Router.render(); return true; }
      if (State.screen === 'help' || State.screen === 'contact') { State.set({ screen: supportFrom || 'home' }); Router.render(); return true; }
      if (State.screen === 'project') {
        if (!force && State.tab === 'files' && Files.view === 'editor' && Files._showTree) { Files._showTree(); return true; }
        if (!force && State.tab !== 'ai') { Router.setTab('ai'); return true; }
        Editor.flush();
        State.set({ screen: 'home' });
        Router.render();
        return true;
      }
      return false;
    }
  };

  // Keep topbar/tabbar in sync with state without re-mounting the screen.
  Bus.on('state', function (p) {
    if (p.health || p.backend) { drawTopbar(); drawTabbar(); }
  });
  Bus.on('agent', function () { if (State.screen === 'project') drawTabbar(); });
  Bus.on('opencode', function () { if (State.screen === 'project') drawTopbar(); });

  g.Router = Router;
})(window);
