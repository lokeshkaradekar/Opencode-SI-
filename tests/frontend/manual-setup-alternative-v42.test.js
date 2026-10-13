const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const js = fs.readFileSync(path.join(root, 'app/js/opencode.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');

test('manual setup alternative is available on the external-apps setup page', () => {
  assert.match(js, /Manual \/ another way/);
  assert.match(js, /Manual setup — step by step/);
  assert.match(js, /manualAltPanel\.style\.display = open \? 'none' : 'block'/);
  assert.match(js, /style: \{ display: 'none' \}/);
});

test('manual setup includes package update, storage, Android permission and workspace commands', () => {
  assert.match(js, /pkg update && pkg upgrade -y/);
  assert.match(js, /termux-setup-storage/);
  assert.match(js, /Settings → Apps → Termux → Permissions/);
  assert.match(js, /Force stop/);
  assert.match(js, /ls -ld ~\/storage\/shared/);
  assert.match(js, /ls -ld ~\/storage\/shared\/Download/);
  assert.match(js, /mkdir -p ~\/storage\/shared\/Download\/opencode-si/);
  assert.match(js, /Copy commands/);
  assert.match(js, /Copy command/);
  assert.match(js, /allow-external-apps/);
});

test('manual command rows remain usable on narrow screens', () => {
  assert.match(css, /\.setup-command-row/);
  assert.match(css, /@media \(max-width:420px\)/);
});


test('manual and copy-command controls have visible outlined button styling', () => {
  assert.match(js, /Manual \/ another way', 'setup-outline'/);
  assert.match(js, /class: 'btn setup-outline', onclick: function \(\) \{ Bridge\.copyText/);
  assert.match(css, /\.btn\.setup-outline/);
  assert.match(css, /\.setup-command-row \.btn/);
  assert.match(css, /border: 1px solid var\(--line-strong/);
});

test('successful first-time setup displays an explicit verified completion state', () => {
  assert.match(js, /Setup successfully completed!/);
  assert.match(js, /All required checks passed/);
  assert.match(js, /Done — setup complete/);
  assert.match(js, /OpenCode\.setupCompletion\(latestChecks\)/);
});
