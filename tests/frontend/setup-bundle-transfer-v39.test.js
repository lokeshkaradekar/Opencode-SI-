const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('large setup bundles are transferred to Termux in acknowledged chunks, not one Binder argument', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/java/TermuxBackend.java'), 'utf8');
  assert.match(source, /stageBundleBase64\(bundle, "setup-bundle\.tar\.gz\.b64", "setup"\)/);
  assert.match(source, /final int chunkSize = 10000/);
  assert.match(source, /CHUNK_OK/);
  assert.match(source, /chunk " \+ index \+ " of " \+ chunks/);
  assert.match(source, /base64 -d \\\"\$sd\/setup-bundle\.tar\.gz\.b64\\\"/);
  assert.match(source, /tar -tzf/);
  assert.match(source, /stageBundleBase64\(bundle, "daemon-update\.tar\.gz\.b64", "daemon update"\)/);
  assert.doesNotMatch(source, /runScript\(script, new String\[\]\{encoded\}, 30000\)/);
});
