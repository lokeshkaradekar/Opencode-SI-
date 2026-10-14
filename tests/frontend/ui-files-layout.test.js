const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('Android WebView viewport prevents pinch zoom and Java disables WebView zoom controls', () => {
  const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  const java = fs.readFileSync(path.join(root, 'app/java/MainActivity.java'), 'utf8');
  assert.match(html, /maximum-scale=1/);
  assert.match(html, /user-scalable=no/);
  assert.match(java, /setSupportZoom\(false\)/);
  assert.match(java, /setBuiltInZoomControls\(false\)/);
  assert.match(java, /setDisplayZoomControls\(false\)/);
});

test('settings and app shell constrain width and wrap long workspace controls on narrow screens', () => {
  const appCss = fs.readFileSync(path.join(root, 'app/css/app.css'), 'utf8');
  const componentCss = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(appCss, /overflow-x: hidden/);
  assert.match(appCss, /max-width: 100vw/);
  assert.match(componentCss, /\.settings \.row \{[^}]*flex-wrap: wrap/s);
  assert.match(componentCss, /overflow-wrap: anywhere/);
});

test('Files exposes actual OpenCode workspace path, refresh, and expand-all folders', () => {
  const files = fs.readFileSync(path.join(root, 'app/js/files.js'), 'utf8');
  assert.match(files, /Chat directory/);
  assert.match(files, /opencodeGetWorkspace/);
  assert.match(files, /Refresh/);
  assert.match(files, /Expand all folders/);
  assert.match(files, /Use project folder/);
});


test('chat transcript cannot pan horizontally when outcome cards contain long paths', () => {
  const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(css, /\.chat-list \{[^}]*overflow-x: hidden/s);
  assert.match(css, /\.chat-list \{[^}]*min-width: 0/s);
  assert.match(css, /\.chat \{[^}]*overflow: hidden/s);
  assert.match(css, /\.outcome-card \{[^}]*overflow-wrap: anywhere/s);
  assert.match(css, /\.outcome-section \.plain code \{[^}]*word-break: break-all/s);
});
