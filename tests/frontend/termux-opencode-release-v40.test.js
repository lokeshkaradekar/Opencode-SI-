const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('OpenCode download uses the actual Termux release tag, not the upstream version tag', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../daemon/termux-setup.sh'), 'utf8');
  assert.match(script, /releases\/download\/v1\.18\.33-termux\/opencode-android-arm64\.tar\.gz/);
  assert.doesNotMatch(script, /releases\/download\/v1\.18\.33\/opencode-android-arm64\.tar\.gz/);
  assert.match(script, /case "\$version" in \*1\.18\.33\*\)/);
});


test('APK setup bundle contains the same corrected OpenCode download URL', () => {
  const bundle = path.join(__dirname, '../../app/setup/daemon-bundle.tar.gz');
  const script = execFileSync('tar', ['-xOzf', bundle, 'daemon/termux-setup.sh'], { encoding: 'utf8' });
  assert.match(script, /releases\/download\/v1\.18\.33-termux\/opencode-android-arm64\.tar\.gz/);
  assert.doesNotMatch(script, /releases\/download\/v1\.18\.33\/opencode-android-arm64\.tar\.gz/);
});
