const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('setup repairs interrupted dpkg state non-interactively before package updates', () => {
  const script = fs.readFileSync(path.join(root, 'daemon/termux-setup.sh'), 'utf8');
  assert.match(script, /OCSI_STAGE=REPAIRING_PACKAGE_CONFIGURATION/);
  assert.match(script, /dpkg --force-confold --configure -a <\/dev\/null/);
  assert.match(script, /apt-get -o Dpkg::Options::=--force-confold --fix-broken install -y/);
  assert.match(script, /apt-get -o Dpkg::Options::=--force-confold update -y/);
  assert.ok(script.indexOf('REPAIRING_PACKAGE_CONFIGURATION') < script.indexOf('UPDATING_PACKAGE_INDEX'));
  assert.match(script, /OCSI_STAGE=VERIFYING_CURL_RUNTIME/);
  assert.match(script, /SSL_set_quic_tls_early_data_enabled/);
  assert.match(script, /install --reinstall -y openssl libcurl curl/);
  assert.ok(script.indexOf('REPAIRING_CURL_RUNTIME') < script.indexOf('DOWNLOADING_OPENCODE'));
  execFileSync('bash', ['-n', path.join(root, 'daemon/termux-setup.sh')]);
});

test('setup UI provides error-specific package recovery and copy/paste fallback', () => {
  const js = fs.readFileSync(path.join(root, 'app/js/opencode.js'), 'utf8');
  assert.match(js, /dpkg returned an error code/);
  assert.match(js, /Copy package repair command/);
  assert.match(js, /dpkg --force-confold --configure -a && apt-get/);
  assert.match(js, /REPAIRING_PACKAGE_CONFIGURATION: 'Repairing interrupted Termux packages'/);
  assert.match(js, /SSL_set_quic_tls_early_data_enabled/);
  assert.match(js, /Copy curl repair command/);
  assert.match(js, /install --reinstall -y openssl libcurl curl/);
});

test('APK setup bundle contains the repaired installer script', () => {
  const bundle = path.join(root, 'app/setup/daemon-bundle.tar.gz');
  const list = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' });
  assert.match(list, /daemon\/termux-setup\.sh/);
  const content = execFileSync('tar', ['-xOzf', bundle, 'daemon/termux-setup.sh'], { encoding: 'utf8' });
  assert.match(content, /dpkg --force-confold --configure -a/);
  assert.match(content, /OCSI_STAGE=REPAIRING_CURL_RUNTIME/);
  assert.match(content, /install --reinstall -y openssl libcurl curl/);
});
