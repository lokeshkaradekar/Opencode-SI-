/* state.js — persistence wrapper, event bus, global state.
   Secrets are NEVER persisted here (see Bridge.setSecret). */
(function (g) {
  'use strict';
  var mem = {};

  var Persist = {
    get: function (k, d) {
      try { var v = localStorage.getItem('mc.' + k); return v == null ? d : JSON.parse(v); }
      catch (e) { return (k in mem) ? mem[k] : d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch (e) { mem[k] = v; }
    },
    del: function (k) {
      try { localStorage.removeItem('mc.' + k); } catch (e) { /* ignore */ }
      delete mem[k];
    },
    clearAll: function () {
      try {
        Object.keys(localStorage).filter(function (k) { return k.indexOf('mc.') === 0; }).forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) { /* ignore */ }
      Object.keys(mem).forEach(function (k) { delete mem[k]; });
    }
  };

  var listeners = {};
  var Bus = {
    on: function (name, fn) {
      (listeners[name] = listeners[name] || new Set()).add(fn);
      return function () { listeners[name].delete(fn); };
    },
    emit: function (name, data) {
      (listeners[name] || []).forEach(function (fn) {
        try { fn(data); } catch (e) { console.error('[bus:' + name + ']', e); }
      });
    }
  };

  var State = {
    screen: 'home',            // home | settings | project
    tab: 'ai',                 // ai | files | terminal | git | health
    project: null,             // {id, name, backend, agent}
    backend: 'local',          // local | remote
    theme: Persist.get('theme', 'dark'),
    health: { status: 'unknown', checks: [], at: 0 },
    loop: { stage: null, log: [] },   // reliability loop: detect/diagnose/repair/verify/fallback/resume
    set: function (patch) {
      Object.keys(patch).forEach(function (k) { State[k] = patch[k]; });
      Bus.emit('state', patch);
    }
  };

  function applyTheme() {
    var r = document.documentElement;
    r.setAttribute('data-theme', State.theme || 'dark');
  }

  var THEMES = [
    { id: 'dark', name: 'Dark (Default)', desc: 'Modern dark theme', swatch: ['#0a1116', '#627cf6', '#16232b'] },
    { id: 'blue-ocean', name: 'Blue Ocean', desc: 'Clean and professional', swatch: ['#001123', '#0395f8', '#0a2847'] },
    { id: 'green-forest', name: 'Green Forest', desc: 'Calm and focused', swatch: ['#04150f', '#35d952', '#10291f'] },
    { id: 'purple-nebula', name: 'Purple Nebula', desc: 'Premium and stylish', swatch: ['#0f0a1e', '#cd71f8', '#1e1536'] },
    { id: 'amber-sunset', name: 'Amber Sunset', desc: 'Warm and modern', swatch: ['#170f06', '#fcc90c', '#2d1e0d'] },
    { id: 'light', name: 'Light', desc: 'Clean light theme', swatch: ['#eef1f5', '#007aff', '#ffffff'] }
  ];

  g.Persist = Persist;
  g.Bus = Bus;
  g.State = State;
  g.THEMES = THEMES;
  g.applyTheme = applyTheme;
  g.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
})(window);
