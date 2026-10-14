const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('setup completion is derived from current live checks and fails closed on missing/non-ok checks', () => {
  const js = read('app/js/opencode.js');
  assert.match(js, /setupCompletion: function \(checks\)/);
  assert.match(js, /var required = \['termux_app', 'run_command_permission', 'external_apps', 'workspace_access', 'opencode_found', 'opencode_runs', 'server_running', 'server_health', 'test_session'\]/);
  assert.match(js, /map\[key\]\.status !== 'ok'/);
});

test('home shows a persistent setup banner until all live required checks pass', () => {
  const js = read('app/js/app.js');
  assert.match(js, /home-setup-pending/);
  assert.match(js, /checkHomeSetup\(\)/);
  assert.match(js, /Setup is not complete:/);
  assert.match(js, /Continue setup/);
  assert.match(js, /Persist\.del\('oc\.setupCompletedAt'\)/);
});

test('every cold launch retries incomplete setup instead of suppressing it after one dismissal', () => {
  const js = read('app/js/app.js');
  assert.match(js, /Never persist a 'wizard already shown' flag/);
  assert.match(js, /if \(!r\.result\.complete && State\.backend !== 'remote'\)/);
  assert.doesNotMatch(js, /Persist\.get\('oc\.setupShown'/);
});

test('blocked Termux commands show copy/paste recovery steps', () => {
  const js = read('app/js/opencode.js');
  assert.match(js, /Finish setup manually \(one time\)/);
  assert.match(js, /paste the command at the Termux prompt, and press Enter/);
  assert.match(js, /Force stop/);
  assert.match(js, /tap “Check again”/);
});
