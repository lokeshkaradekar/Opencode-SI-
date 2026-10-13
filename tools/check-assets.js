// "Build" step: there is no bundler. This validates that the asset folder is complete and consistent
// (every script/CSS referenced by app/index.html exists and parses) so a broken APK is caught early.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'app');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css))"/g)].map((m) => m[1]);
let bad = 0;
for (const r of refs) {
  const p = path.join(root, r);
  if (!fs.existsSync(p)) { console.error('MISSING', r); bad++; continue; }
  if (r.endsWith('.js')) { try { new Function(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('SYNTAX', r, e.message); bad++; } }
}
if (/dev\/mock|MockBackend/.test(html)) { console.error('index.html must not load the mock'); bad++; }
const setupBundle = path.join(root, 'setup', 'daemon-bundle.tar.gz');
if (!fs.existsSync(setupBundle) || fs.statSync(setupBundle).size < 1024) { console.error('MISSING or invalid setup/daemon-bundle.tar.gz'); bad++; }
for (const f of ['java/NativeBridge.java', 'java/TermuxBackend.java']) { if (!fs.existsSync(path.join(root, f))) { console.error('MISSING bridge source', f); bad++; } }
console.log((refs.length + 1) + ' assets checked, ' + bad + ' problem(s)');
process.exit(bad ? 1 : 0);
