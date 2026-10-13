const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('storage setup does not rerun termux-setup-storage when shared access already works', () => {
  const java = read('app/java/OpenCodeServer.java');
  assert.match(java, /STORAGE_ACCESS_ALREADY_READY/);
  assert.match(java, /\[ -d \\\"\$shared\\\" \] && \[ -r \\\"\$shared\\\" \] && \[ -w \\\"\$shared\\\" \]/);
  assert.match(java, /termux-setup-storage/);
  assert.match(java, /Final success is always determined by setupChecks\(\)/);
});

test('storage failure offers a copied manual checklist with the correct Termux shared path', () => {
  const js = read('app/js/opencode.js');
  assert.match(js, /Copy manual storage steps/);
  assert.ok(js.includes('ls -la ~/storage/shared'));
  assert.ok(js.includes('ls -la ~/storage/shared/Download'));
  assert.ok(js.includes('mkdir -p ~/storage/shared/Download/opencode-si'));
  assert.match(js, /Android Settings → Apps → Termux → Permissions/);
  assert.match(js, /tap “Check again”/);
});
