const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Health exposes a single Auto Setup & Repair entry point for local failures', () => {
  const js = read('app/js/health.js');
  assert.match(js, /health-auto-repair/);
  assert.match(js, /OpenCode\.setupSheet\(\)/);
  assert.match(js, /guides you through any Android or Termux permission that must be approved manually/);
});

test('Termux recovery command updates and verifies allow-external-apps without repeating storage setup', () => {
  const js = read('app/js/opencode.js');
  assert.match(js, /sed -i 's\/\^\[\[:space:\]\]\*allow-external-apps/);
  assert.match(js, /allow-external-apps = true/);
  assert.match(js, /Saved setting:/);
  assert.doesNotMatch(js.match(/var externalCommand = ([\s\S]*?);\n/)[1], /termux-setup-storage/);
  assert.match(js, /Copy one-time fix command/);
  assert.match(js, /Force stop/);
  assert.match(js, /allow-external-apps = true/);
});


test('setup command is full-width and not styled as the 22px code icon', () => {
  const js = read('app/js/opencode.js');
  const css = read('app/css/components.css');
  assert.match(js, /class: 'setup-command-block'/);
  assert.doesNotMatch(js, /class: 'code setup-command/);
  assert.match(css, /\.setup-command-block \{[^}]*width:100%/);
  assert.match(css, /\.setup-command-block \{[^}]*min-width:0/);
});

test('Termux storage guidance distinguishes storage links from external-command access', () => {
  const java = read('app/java/OpenCodeServer.java');
  const js = read('app/js/opencode.js');
  assert.match(java, /r\.error != null \|\| r\.exitCode != 0/);
  assert.match(java, /allow-external-apps/);
  assert.match(js, /does not enable external-app commands/);
});
