const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('agent replies use safe structured Markdown rendering instead of raw pre-wrapped text', () => {
  const js = fs.readFileSync(path.join(root, 'app/js/agent.js'), 'utf8');
  assert.match(js, /function renderReply\(text\)/);
  assert.match(js, /function inlineReply\(parent, source\)/);
  assert.match(js, /m\.role === 'agent' \? renderReply\(m\.text\) : m\.text/);
  assert.match(js, /node\.textContent = token/);
  assert.match(js, /node\.rel = 'noopener noreferrer'/);
});

test('Light theme contrast guard applies across all app screens and keeps semantic button colours', () => {
  const css = fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8');
  assert.match(css, /:root\[data-theme="light"\] #app :is\(div,span,h1,h2/);
  assert.match(css, /-webkit-text-fill-color: var\(--ink\) !important/);
  assert.match(css, /\.btn\.primary[^\{]*\* \{/);
  assert.match(css, /\.reply-markdown pre/);
  assert.match(css, /\.reply-markdown ul/);
});
