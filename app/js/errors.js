/* errors.js — Error Intelligence (Phase 11) and secret redaction (Phase 21).
   Turns raw errors into: category + domain + plain explanation + technical details.
   Runtime, provider and project errors are never merged into one generic error. */
(function (g) {
  'use strict';

  var Redact = {
    text: function (t) {
      return String(t == null ? '' : t)
        .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, '[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}/gi, 'Bearer [redacted]')
        .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)[A-Za-z0-9._\-]{12,}/gi, '$1[redacted]')
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]');
    }
  };

  var DOMAIN = {
    SETUP: 'runtime', SERVER: 'runtime', OS: 'runtime', RUNTIME: 'runtime', NATIVE: 'runtime', PACKAGE: 'runtime', TERMINAL: 'runtime',
    PROCESS: 'runtime', STORAGE: 'runtime',
    NETWORK: 'provider', AUTH: 'provider', PROVIDER: 'provider', MODEL: 'provider',
    FILESYSTEM: 'project', PERMISSION: 'project', GIT: 'project', PROJECT: 'project',
    UNKNOWN: 'runtime'
  };

  // Ordered: first match wins. Most specific first.
  var RULES = [
    { re: /TERMUX_MISSING|PERMISSION_MISSING|OPENCODE_NOT_FOUND|WORKSPACE_INACCESSIBLE|WORKSPACE_INVALID|BACKEND_UNAVAILABLE/, cat: 'SETUP',
      title: 'OpenCode setup is incomplete',
      simple: 'Termux, the Termux permission, the OpenCode program or the workspace folder is not ready. Open the OpenCode status to see which one.',
      causes: ['Termux is not installed', 'OpenCode SI may not run Termux commands yet', 'OpenCode is not installed in Termux', 'The folder does not exist or Termux cannot access it'] },
    { re: /RESTARTING|STARTING_SERVER|WAITING_FOR_HEALTH|CHECKING_SERVER|CHECKING_TERMUX/, cat: 'SERVER',
      title: 'OpenCode is still starting',
      simple: 'OpenCode SI has not confirmed that the server is ready yet. The app will retry startup; if this persists, open the OpenCode diagnostics and check the server log.',
      causes: ['Termux is taking longer than expected to launch OpenCode', 'A previous server start is still in progress', 'The server process did not finish starting'] },
    { re: /PORT_CONFLICT|STARTUP_TIMEOUT|START_FAILED|SERVER_DOWN|OPENCODE_UNREACHABLE|OPENCODE_CONNECTION_LOST|SERVER_LOST|STOP_FAILED|WORKSPACE_MISMATCH|WORKSPACE_BUSY|OPENCODE_NOT_READY/, cat: 'SERVER',
      title: 'The OpenCode server is not available',
      simple: 'The OpenCode server did not start, stopped answering, or is working in a different folder. Your project files were not touched.',
      causes: ['Android stopped the Termux process', 'The port is used by another program', 'A server for another folder is already running'] },
    { re: /OUTCOME_UNKNOWN/, cat: 'SERVER',
      title: 'The outcome of the task is not known',
      simple: 'The connection broke while the agent was working, so the app cannot tell whether it finished. Check the changed files, then continue the session.',
      causes: ['Android froze or killed the app while the task ran', 'The OpenCode server was restarted'] },
    { re: /AGENT_UNAVAILABLE/, cat: 'SERVER',
      title: 'Plan mode is not available',
      simple: 'This OpenCode server does not list a Plan agent, so Plan mode cannot run. Build is not affected.',
      causes: ['This OpenCode version/config has no plan agent configured'] },
    { re: /AUTH_REQUIRED|AUTH_REJECTED|OPENCODE_AUTH_FAILED/, cat: 'SERVER',
      title: 'OpenCode needs a password',
      simple: 'A server is running that wants credentials this app does not have. Stop it in Termux so the app can start its own, or enter its password in Settings.',
      causes: ['The server was started by hand with OPENCODE_SERVER_PASSWORD'] },
    { re: /PROVIDER_AUTH/, cat: 'AUTH',
      title: 'OpenCode\u2019s model provider did not accept the login',
      simple: 'The provider behind the selected model refused the request. Check the login in Termux (opencode auth list) or choose another model.',
      causes: ['Login expired or missing', 'This model needs a plan you do not have'] },
    { re: /dlopen failed|library ".*\.so.*" not found|cannot open shared object/i, cat: 'NATIVE',
      title: 'A native library is missing',
      simple: 'The coding agent needs a system library that is not installed or cannot be loaded on this device.',
      causes: ['A library was removed by a package update', 'The agent build does not match this CPU or Android version', 'An installation was interrupted'] },
    { re: /SyntaxError|Unexpected token|Invalid or unexpected token/i, cat: 'RUNTIME',
      title: 'The agent could not load one of its modules',
      simple: 'The coding agent could not load one of its JavaScript modules.',
      causes: ['Runtime version mismatch', 'Corrupted dependency', 'Incompatible package', 'Malformed generated file'] },
    { re: /ENOSPC|no space left|low storage/i, cat: 'STORAGE',
      title: 'The device is almost out of storage',
      simple: 'There is not enough free space to write files, so tools and installs are failing.',
      causes: ['Large caches or build output', 'Many repository clones', 'Device storage nearly full'] },
    { re: /SIGKILL|exit code 137|\bKilled\b|process (was )?killed|signal 9/i, cat: 'PROCESS',
      title: 'The process was stopped by Android',
      simple: 'Android ended the process, usually to free memory or save battery.',
      causes: ['Phantom-process or battery limits', 'Memory pressure', 'App was in the background too long'] },
    { re: /openpty|\bpty\b|not a tty|tcgetattr/i, cat: 'TERMINAL',
      title: 'The terminal could not start',
      simple: 'A pseudo-terminal could not be created, so interactive commands cannot run.',
      causes: ['Termux session limit reached', 'Missing terminal support in the backend'] },
    { re: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network is unreachable|getaddrinfo|offline/i, cat: 'NETWORK',
      title: 'The network is not reachable',
      simple: 'The device could not reach the server. Nothing is wrong with your project or the agent.',
      causes: ['No internet connection', 'Weak or captive-portal Wi-Fi', 'DNS problem'] },
    { re: /\b401\b|invalid[_ ]api[_ ]key|unauthorized|authentication|expired (key|token)|no api key/i, cat: 'AUTH',
      title: 'The provider rejected the API key',
      simple: 'The AI provider did not accept the saved key. It may be missing, mistyped or expired.',
      causes: ['Key was revoked or expired', 'Key belongs to a different provider', 'Key was never saved'] },
    { re: /\b429\b|rate.?limit|quota|too many requests/i, cat: 'PROVIDER',
      title: 'The provider is limiting requests',
      simple: 'You hit a rate limit or usage quota with this provider.',
      causes: ['Too many requests in a short time', 'Monthly quota used up'] },
    { re: /\b(502|503|504|529)\b|overloaded|service unavailable|upstream|provider outage/i, cat: 'PROVIDER',
      title: 'The provider is having an outage',
      simple: 'The AI provider is unavailable right now. Another provider can take over.',
      causes: ['Provider outage or overload', 'Regional routing problem'] },
    { re: /model .*(not found|unavailable|does not exist)|unknown model/i, cat: 'MODEL',
      title: 'The selected model is unavailable',
      simple: 'This provider does not offer the model you picked.',
      causes: ['Model was retired or renamed', 'Your plan does not include it'] },
    { re: /context (length|window)|too many tokens|maximum context/i, cat: 'MODEL',
      title: 'The conversation is too long for the model',
      simple: 'The request was larger than the model can read at once.',
      causes: ['Very long chat history', 'Too many large files attached'] },
    { re: /not a git repository|merge conflict|CONFLICT|^fatal:|nothing to commit|pathspec/im, cat: 'GIT',
      title: 'Git could not complete the operation',
      simple: 'Git refused the operation. Your history has not been changed.',
      causes: ['Merge conflict', 'Not a repository', 'Nothing staged or unknown path'] },
    { re: /PATH_OUTSIDE_PROJECT|EACCES|permission denied|PERMISSION_DENIED|EPERM/i, cat: 'PERMISSION',
      title: 'Access was denied',
      simple: 'The app is not allowed to read or write that location.',
      causes: ['Path is outside the project folder', 'Missing storage permission', 'File owned by another app'] },
    { re: /ENOENT|no such file|NOT_FOUND|FILE_TOO_LARGE/i, cat: 'FILESYSTEM',
      title: 'A file could not be used',
      simple: 'The file or folder was not found, or it is too large to open safely.',
      causes: ['File was moved or deleted', 'File is larger than the 1 MB editor limit'] },
    { re: /npm ERR|ERESOLVE|Cannot find module|MODULE_NOT_FOUND|peer dep/i, cat: 'PACKAGE',
      title: 'A package problem blocked the command',
      simple: 'A dependency is missing or its version does not fit.',
      causes: ['Interrupted install', 'Version conflict', 'Missing dependency'] },
    { re: /Exec format error|unsupported architecture|bad ELF|android api level/i, cat: 'OS',
      title: 'This build does not match the device',
      simple: 'A program was built for a different CPU or Android version.',
      causes: ['32-bit vs 64-bit mismatch', 'Binary built for desktop Linux'] },
    { re: /NO_PROJECT|no active project|package\.json not found/i, cat: 'PROJECT',
      title: 'No project is open',
      simple: 'Open or create a project first.',
      causes: ['App was restarted', 'Project was removed'] }
  ];

  var Errors = {
    categories: ['OS', 'RUNTIME', 'NATIVE', 'PACKAGE', 'FILESYSTEM', 'PERMISSION', 'TERMINAL', 'PROCESS', 'NETWORK', 'AUTH', 'PROVIDER', 'MODEL', 'GIT', 'PROJECT', 'STORAGE', 'UNKNOWN'],
    domainOf: function (cat) { return DOMAIN[cat] || 'runtime'; },
    classify: function (raw, code) {
      var text = Redact.text((raw && raw.message) ? raw.message + '\n' + (raw.details || '') : raw);
      var hay = text + ' ' + (code || '');
      for (var i = 0; i < RULES.length; i++) {
        if (RULES[i].re.test(hay)) {
          var r = RULES[i];
          return {
            category: r.cat, domain: DOMAIN[r.cat], title: r.title, simple: r.simple,
            causes: r.causes, projectSafe: true, technical: text.trim()
          };
        }
      }
      return {
        category: 'UNKNOWN', domain: 'runtime', title: 'Something unexpected went wrong',
        simple: 'The error did not match a known problem. Run the health checks to narrow it down.',
        causes: [], projectSafe: true, technical: text.trim() || 'No details were reported.'
      };
    }
  };

  g.Redact = Redact;
  g.Errors = Errors;
})(window);
