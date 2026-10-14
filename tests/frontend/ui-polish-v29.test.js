const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
test('v29 outcome card has explicit completion status styling', () => {
  const js = fs.readFileSync(path.join(root, 'app/js/agent.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(js, /outcome-status/);
  assert.match(css, /\.outcome-status/);
  assert.match(css, /\.outcome-mark/);
});
test('Stop server uses the shared outlined server action style', () => {
  const js = fs.readFileSync(path.join(root, 'app/js/opencode.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(js, /stop-server-action/);
  assert.match(css, /\.oc-agent-actions > \.btn\.stop-server-action/);
});
test('pull-to-refresh refreshes the current router screen without restarting the app', () => {
  const app = fs.readFileSync(path.join(root, 'app/js/app.js'), 'utf8');
  const router = fs.readFileSync(path.join(root, 'app/js/router.js'), 'utf8');
  assert.match(app, /installPullToRefresh/);
  assert.match(app, /Router\.refresh/);
  assert.match(router, /refresh: function/);
});
test('Light theme picker explicitly uses theme ink and muted tokens', () => {
  const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(css, /\.theme-card, \.theme-card \.theme-text, \.theme-card \.theme-text strong \{ color: var\(--ink\) !important; \}/);
  assert.match(css, /\.theme-card \.theme-text \.muted \{ color: var\(--muted\) !important; \}/);
});


test('v30 scopes progress connector lines to health loop and forces light-theme text contrast', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../../app/css/components.css'), 'utf8');
  assert.match(css, /\.loop \.seg:not\(:last-child\)::after/);
  assert.match(css, /:root\[data-theme="light"\] \.settings \.theme-card \.theme-text strong[\s\S]*?-webkit-text-fill-color: var\(--ink\) !important/);
  assert.match(css, /:root\[data-theme="light"\] \.settings \.panel \.muted[\s\S]*?-webkit-text-fill-color: var\(--muted\) !important/);
});
