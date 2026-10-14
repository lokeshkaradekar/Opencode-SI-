#!/usr/bin/env python3
"""Stand-in for the `opencode` executable, used ONLY by tests/java to exercise the real Termux shell scripts.
It is not OpenCode: it implements just --version, models and `serve` (health, path, session list) so process handling
(nohup/setsid/pid file/stop) can be tested on real processes."""
import base64, json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

a = sys.argv[1:]
if a[:1] == ['--version']:
    print('1.18.33-termux'); sys.exit(0)
if a[:1] == ['models']:
    print('opencode/big-pickle'); print('opencode/exo-free'); sys.exit(0)
if a[:1] != ['serve']:
    sys.stderr.write('unknown command\n'); sys.exit(2)

port = int(a[a.index('--port') + 1]); host = a[a.index('--hostname') + 1]
pw = os.environ.get('OPENCODE_SERVER_PASSWORD') or None
want = 'Basic ' + base64.b64encode(('opencode:' + pw).encode()).decode() if pw else None

class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if want and self.headers.get('Authorization') != want:
            return self._send(401, {'error': 'unauthorized'})
        if self.path == '/global/health': return self._send(200, {'healthy': True, 'version': '1.18.33-termux'})
        if self.path == '/path': return self._send(200, {'directory': os.getcwd()})
        if self.path == '/session': return self._send(200, [])
        return self._send(404, {'error': 'not found'})

HTTPServer((host, port), H).serve_forever()
