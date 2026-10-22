/* bridge.js — the ONLY place the UI talks to the outside world.
   UI -> frontend service -> Bridge -> (Android | mock).
   Every call returns {success,data,error,requestId}; the wrappers below unwrap
   it and throw BridgeError so callers can use try/catch + Errors.classify(). */
(function (g) {
  'use strict';

  var native = g.AndroidBridge || null;   // injected by MainActivity via addJavascriptInterface
  var pending = {};
  var seq = 0;
  var TIMEOUT_MS = 120000;

  // Allowlist mirrors NativeBridge.java. No generic "execute anything" entry point exists.
  var METHODS = [
    'getEnvironment', 'healthCheck', 'daemonStatus', 'configureDaemon', 'startDaemon', 'beginSetupInstall', 'setupInstallProgress', 'copyText', 'requestTermuxPermission',
    'listProjects', 'createProject', 'openExistingProject', 'pickProjectLocation', 'renameProject', 'deleteProject', 'cloneProject', 'importZip', 'openProject', 'detectProject',
    'listFiles', 'readFile', 'writeFile', 'createFile', 'pickFileForProject', 'createFolder', 'deleteFile', 'moveFile', 'exists', 'searchFiles',
    'runCommand', 'cancelCommand', 'interruptCommand', 'sendInput', 'resizeTerminal', 'restartTerminal',
    'gitStatus', 'gitDiff', 'gitLog', 'gitCommit', 'gitRestore', 'gitOp',
    'agentStart', 'agentSend', 'agentCancel', 'agentResume', 'agentStatus', 'agentHistory', 'agentUsage', 'getPermissionMode', 'setPermissionMode', 'getCommandAuditLog',
    'opencodeStatus', 'opencodeEnsure', 'opencodeSwitchRepair', 'opencodeRecheck', 'opencodeStop', 'opencodeDiagnostics', 'opencodeSetupChecks', 'termuxSetupStorage',
    'opencodeGetWorkspace', 'opencodeSetWorkspace', 'opencodePickWorkspace', 'opencodeSetPassword',
    'opencodeSessions', 'opencodeModels', 'opencodeSetModel', 'openAppSettings', 'openTermux', 'openSupportLink',
    'providerHealth', 'listModels', 'getProviderConfig', 'setProviderConfig', 'setSecret', 'deleteSecret', 'hasSecret',
    'snapshotCreate', 'snapshotList', 'snapshotInspect', 'snapshotRollback', 'repair', 'setBackend'
  ];
  // Methods that legitimately run longer than the default; 0 = no UI timeout (the native side enforces its own).
  var TIMEOUTS = { agentStart: 150000, agentSend: 150000, opencodeEnsure: 150000, opencodeStop: 60000, opencodeSetupChecks: 150000, beginSetupInstall: 45000, setupInstallProgress: 20000, opencodeModels: 90000, opencodeSetModel: 90000, runCommand: 0, cloneProject: 700000, gitOp: 700000, healthCheck: 90000, providerHealth: 60000, listModels: 60000 };
  // Development-only controls, available ONLY when dev.html loaded dev/mock.js. Never in the APK UI.
  var MOCK_ONLY = ['setChaos', 'getChaos', 'resetDemo'];
  var mock = g.MockBackend || null;

  // Called by Java: webView.evaluateJavascript("window.__bridgeResolve(id, json)")
  g.__bridgeResolve = function (requestId, json) {
    var p = pending[requestId];
    if (!p) return;
    delete pending[requestId];
    if (p.timer) clearTimeout(p.timer);
    try { p.resolve(typeof json === 'string' ? JSON.parse(json) : json); }
    catch (e) { p.resolve({ success: false, data: null, error: { code: 'BAD_RESPONSE', message: 'Native layer returned invalid data.' }, requestId: requestId }); }
  };

  // Called by Java for pushed events (live terminal output, permission results).
  var listeners = {};
  g.__bridgeEvent = function (name, json) {
    var data; try { data = JSON.parse(json); } catch (e) { return; }
    (listeners[name] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { /* listener errors never break the bridge */ } });
  };

  function BridgeError(err) {
    var e = new Error(err.message || 'Bridge error');
    e.name = 'BridgeError';
    e.code = err.code || 'UNKNOWN';
    e.details = err.details || null;
    return e;
  }

  function raw(method, args) {
    var requestId = 'r' + (++seq) + '-' + Date.now().toString(36);
    var allowed = METHODS.indexOf(method) >= 0 || (!native && !!mock && MOCK_ONLY.indexOf(method) >= 0);
    if (!allowed) {
      return Promise.resolve({ success: false, data: null, error: { code: 'UNKNOWN_METHOD', message: 'Method not allowed: ' + method }, requestId: requestId });
    }
    if (!native && mock) return mock.handle(method, args, requestId);        // dev.html only
    if (!native) {
      // Production never fakes a backend: a missing bridge is a real, visible error.
      return Promise.resolve({ success: false, data: null, requestId: requestId,
        error: { code: 'BRIDGE_UNAVAILABLE', message: 'This page is not running inside the OpenCode SI Android app, so there is no backend.' } });
    }
    return new Promise(function (resolve) {
      var tmo = TIMEOUTS.hasOwnProperty(method) ? TIMEOUTS[method] : TIMEOUT_MS;
      var timer = tmo > 0 ? setTimeout(function () {
        delete pending[requestId];
        resolve({ success: false, data: null, error: { code: 'TIMEOUT', message: 'The native layer did not answer in time.' }, requestId: requestId });
      }, tmo) : null;
      pending[requestId] = { resolve: resolve, timer: timer };
      try { native.request(JSON.stringify({ requestId: requestId, method: method, args: args || {} })); }
      catch (e) {
        if (timer) clearTimeout(timer);
        delete pending[requestId];
        resolve({ success: false, data: null, error: { code: 'BRIDGE_UNAVAILABLE', message: String(e) }, requestId: requestId });
      }
    });
  }

  function call(method, args) {
    return raw(method, args).then(function (res) {
      if (!res.success) throw BridgeError(res.error || {});
      return res.data;
    });
  }

  var Bridge = {
    mode: native ? 'native' : (mock ? 'mock' : 'none'),
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); },
    raw: raw,
    call: call,

    getEnvironment: function () { return call('getEnvironment'); },
    healthCheck: function () { return call('healthCheck'); },

    listProjects: function () { return call('listProjects'); },
    createProject: function (name, parent) { return call('createProject', { name: name, parent: parent || '' }); },
    openExistingProject: function (name, path) { return call('openExistingProject', { name: name, path: path }); },
    pickProjectLocation: function () { return call('pickProjectLocation'); },
    renameProject: function (id, name) { return call('renameProject', { id: id, name: name }); },
    deleteProject: function (id) { return call('deleteProject', { id: id }); },
    cloneProject: function (url) { return call('cloneProject', { url: url }); },
    importZip: function () { return call('importZip'); },
    openProject: function (id) { return call('openProject', { id: id }); },

    listFiles: function (path) { return call('listFiles', { path: path || '' }); },
    readFile: function (path) { return call('readFile', { path: path }); },
    writeFile: function (path, content) { return call('writeFile', { path: path, content: content }); },
    createFile: function (path, content) { return call('createFile', { path: path, content: content || '' }); },
    pickFileForProject: function () { return call('pickFileForProject'); },
    deleteFile: function (path) { return call('deleteFile', { path: path }); },
    moveFile: function (from, to) { return call('moveFile', { from: from, to: to }); },
    exists: function (path) { return call('exists', { path: path }); },
    searchFiles: function (query) { return call('searchFiles', { query: query }); },

    runCommand: function (command, confirmed) { return call('runCommand', { command: command, confirmed: !!confirmed }); },
    cancelCommand: function () { return call('cancelCommand'); },
    interruptCommand: function () { return call('interruptCommand'); },
    sendInput: function (data) { return call('sendInput', { data: data }); },
    restartTerminal: function () { return call('restartTerminal'); },
    daemonStatus: function () { return call('daemonStatus'); },
    configureDaemon: function (port, token) { return call('configureDaemon', { port: port, token: token || null }); },
    startDaemon: function () { return call('startDaemon'); },
    requestTermuxPermission: function () { return call('requestTermuxPermission'); },
    copyText: function (text) { return call('copyText', { text: String(text || '') }); },
    detectProject: function () { return call('detectProject'); },
    createFolder: function (path) { return call('createFolder', { path: path }); },
    gitOp: function (op, args) { return call('gitOp', { op: op, args: args || {} }); },
    resizeTerminal: function (cols, rows) { return call('resizeTerminal', { cols: cols, rows: rows }); },

    gitStatus: function () { return call('gitStatus'); },
    gitDiff: function (path) { return call('gitDiff', { path: path || null }); },
    gitLog: function () { return call('gitLog'); },
    gitCommit: function (message, confirmSecrets) { return call('gitCommit', { message: message, confirmSecrets: !!confirmSecrets }); },
    gitRestore: function (path, confirmed) { return call('gitRestore', { path: path, confirmed: !!confirmed }); },

    agentStart: function () { return call('agentStart'); },
    agentSend: function (sessionId, message, mode, permissionMode, permissionConfirmed) { return call('agentSend', { sessionId: sessionId, message: message, mode: mode || '', permissionMode: permissionMode || '', permissionConfirmed: !!permissionConfirmed }); },
    agentStatus: function (sessionId, since) { return call('agentStatus', { sessionId: sessionId, since: since || 0 }); },
    agentCancel: function (sessionId) { return call('agentCancel', { sessionId: sessionId }); },
    agentResume: function (sessionId) { return call('agentResume', { sessionId: sessionId }); },
    agentHistory: function (sessionId) { return call('agentHistory', { sessionId: sessionId }); },
    agentUsage: function (sessionId) { return call('agentUsage', { sessionId: sessionId }); },
    getPermissionMode: function () { return call('getPermissionMode'); },
    setPermissionMode: function (mode) { return call('setPermissionMode', { mode: mode }); },
    getCommandAuditLog: function () { return call('getCommandAuditLog'); },

    opencodeStatus: function () { return call('opencodeStatus'); },
    opencodeEnsure: function (force) { return call('opencodeEnsure', { force: !!force }); },
    opencodeSwitchRepair: function (confirmed) { return call('opencodeSwitchRepair', { confirmed: !!confirmed }); },
    opencodeRecheck: function () { return call('opencodeRecheck'); },
    opencodeStop: function (force) { return call('opencodeStop', { force: !!force }); },
    opencodeDiagnostics: function () { return call('opencodeDiagnostics'); },
    opencodeSetupChecks: function () { return call('opencodeSetupChecks'); },
    termuxSetupStorage: function () { return call('termuxSetupStorage'); },
    beginSetupInstall: function () { return call('beginSetupInstall'); },
    setupInstallProgress: function () { return call('setupInstallProgress'); },
    opencodeGetWorkspace: function () { return call('opencodeGetWorkspace'); },
    opencodeSetWorkspace: function (mode, path) { return call('opencodeSetWorkspace', { mode: mode, path: path || '' }); },
    opencodePickWorkspace: function () { return call('opencodePickWorkspace'); },
    opencodeSetPassword: function (value) { return call('opencodeSetPassword', { value: value }); },
    opencodeSessions: function () { return call('opencodeSessions'); },
    opencodeModels: function () { return call('opencodeModels'); },
    opencodeSetModel: function (id) { return call('opencodeSetModel', { id: id }); },
    openAppSettings: function () { return call('openAppSettings'); },
    openTermux: function () { return call('openTermux'); },
    openSupportLink: function (destination, details) { return call('openSupportLink', { destination: destination, subject: details && details.subject ? String(details.subject).slice(0, 120) : '', body: details && details.body ? String(details.body).slice(0, 5000) : '' }); },

    providerHealth: function (id) { return call('providerHealth', { id: id }); },
    listModels: function (id) { return call('listModels', { id: id }); },
    getProviderConfig: function (id) { return call('getProviderConfig', { id: id }); },
    setProviderConfig: function (id, baseUrl, model) { return call('setProviderConfig', { id: id, baseUrl: baseUrl, model: model }); },
    setSecret: function (id, value) { return call('setSecret', { id: id, value: value }); },
    deleteSecret: function (id) { return call('deleteSecret', { id: id }); },
    hasSecret: function (id) { return call('hasSecret', { id: id }); },

    snapshotCreate: function (label, good) { return call('snapshotCreate', { label: label, good: !!good }); },
    snapshotList: function () { return call('snapshotList'); },
    snapshotInspect: function (id) { return call('snapshotInspect', { id: id }); },
    snapshotRollback: function (id, confirmed) { return call('snapshotRollback', { id: id, confirmed: !!confirmed }); },
    repair: function (level) { return call('repair', { level: level }); },
    setBackend: function (name) { return call('setBackend', { name: name }); },

    // Mock-only controls (rejected when a real native bridge is present)
    setChaos: function (flag, on) { return call('setChaos', { flag: flag, on: on }); },
    getChaos: function () { return call('getChaos'); },
    resetDemo: function () { return call('resetDemo'); }
  };

  g.Bridge = Bridge;
})(window);
