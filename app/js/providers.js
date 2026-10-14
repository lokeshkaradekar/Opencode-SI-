/* providers.js — AI Gateway (Phase 10). No provider is a permanent single point
   of failure: if the active one is unhealthy, failover() picks the next healthy one.
   API keys go to Bridge.setSecret (Android Keystore) and are never kept in JS state. */
(function (g) {
  'use strict';

  var Gateway = {
    providers: [
      { id: 'hosted', name: 'Hosted API', desc: 'OpenAI-compatible cloud API (OpenRouter by default) using your key', needsKey: true },
      { id: 'compatible', name: 'Custom endpoint', desc: 'Any OpenAI-compatible server (https://, or http:// on your LAN)', needsKey: true },
      { id: 'local', name: 'Local server in Termux', desc: 'Ollama or llama.cpp server on this phone (http://127.0.0.1:11434/v1). No key', needsKey: false }
    ],
    active: Persist.get('provider', 'hosted'),
    status: {},   // id -> {status, detail, raw}
    config: {},   // id -> {baseUrl, model, hasKey}  (never contains a key)
    models: {},   // id -> [{id,name}]

    loadConfig: function (id) {
      return Bridge.getProviderConfig(id).then(function (c) { Gateway.config[id] = c; Bus.emit('providers'); return c; });
    },
    saveConfig: function (id, baseUrl, model) {
      return Bridge.setProviderConfig(id, baseUrl, model).then(function (c) { Gateway.config[id] = c; Bus.emit('providers'); return c; });
    },
    fetchModels: function (id) {
      return Bridge.listModels(id).then(function (m) { Gateway.models[id] = m; Bus.emit('providers'); return m; });
    },

    byId: function (id) { return Gateway.providers.filter(function (p) { return p.id === id; })[0]; },

    setActive: function (id) {
      Gateway.active = id;
      Persist.set('provider', id);
      Bus.emit('providers');
    },

    check: function (id) {
      return Bridge.providerHealth(id).then(function (r) { return r; }, function (e) {
        return { status: 'failed', detail: e.message, raw: e.details || e.message };
      }).then(function (r) {
        r.raw = r.raw ? Redact.text(r.raw) : null;
        Gateway.status[id] = r;
        Bus.emit('providers');
        return r;
      });
    },

    checkAll: function () {
      return Promise.all(Gateway.providers.map(function (p) { return Gateway.check(p.id); }));
    },

    /* Move to the next healthy provider. Returns {from,to} or null. */
    failover: function () {
      var from = Gateway.active;
      var order = Gateway.providers.map(function (p) { return p.id; }).filter(function (id) { return id !== from; });
      return order.reduce(function (chain, id) {
        return chain.then(function (found) {
          if (found) return found;
          return Gateway.check(id).then(function (s) {
            if (s.status === 'ok') { Gateway.setActive(id); return { from: from, to: id }; }
            return null;
          });
        });
      }, Promise.resolve(null));
    },

    saveKey: function (id, value) {
      return Bridge.setSecret(id, value).then(function () { return Gateway.check(id); });
    },
    removeKey: function (id) {
      return Bridge.deleteSecret(id).then(function () { return Gateway.check(id); });
    }
  };

  g.Gateway = Gateway;
})(window);
