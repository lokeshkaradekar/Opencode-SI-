"""Authenticated loopback HTTP routes and JSON request handling."""
import base64
import hmac
import json
import os
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import ocd_detect
from ocd_config import VERSION, MAX_BODY
from ocd_errors import ApiError
from ocd_policy import Policy
from ocd_processes import Job
from ocd_health import health

def make_handler(d, fs):
    ROUTES = []

    def route(method, pattern):
        def deco(fn):
            ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
            return fn
        return deco

    def b64(a):
        if "data_b64" in a:
            try:
                return base64.b64decode(a["data_b64"], validate=True)
            except Exception:
                raise ApiError("INVALID_ARGUMENT", "data_b64 is not valid base64.", 400)
        data = a.get("data", "")
        if not isinstance(data, str):
            raise ApiError("INVALID_ARGUMENT", "data must be a string.", 400)
        return data.encode("utf-8")

    @route("GET", r"/v1/ping")
    def ping(h, m, q, a):
        return {"daemon": VERSION, "pid": os.getpid(), "uptime": round(time.time() - d.started, 1), "workspace": d.ws.root}

    @route("GET", r"/v1/health")
    def hl(h, m, q, a):
        return health(d, network=q.get("network", ["1"])[0] != "0")

    @route("GET", r"/v1/projects/capabilities")
    def project_capabilities(h, m, q, a):
        return {"daemon": VERSION, "customProjectParents": True, "strictParent": True, "openExistingProjects": True, "binaryFileWrite": True}

    @route("GET", r"/v1/projects")
    def pl(h, m, q, a):
        return fs.projects()

    @route("POST", r"/v1/projects")
    def pc(h, m, q, a):
        if a.get("require_parent") is True and not a.get("parent"):
            raise ApiError("INVALID_PATH", "A custom project parent was required but no parent path was supplied. No project was created.", 400)
        return fs.create_project(a)

    @route("POST", r"/v1/projects/open-existing")
    def poe(h, m, q, a):
        return fs.open_existing_project(a)

    @route("POST", r"/v1/projects/rename")
    def pr(h, m, q, a):
        return fs.rename_project(a)

    @route("POST", r"/v1/projects/delete")
    def pd(h, m, q, a):
        return fs.delete_project(a)

    for name in ("list", "stat", "read", "write", "write_binary", "mkdir", "rename", "copy", "delete", "search"):
        route("POST", r"/v1/fs/" + name)(lambda h, m, q, a, _n=name: getattr(fs, _n)(a))

    @route("POST", r"/v1/sessions")
    def sc(h, m, q, a):
        return d.api_session_create(a)

    @route("GET", r"/v1/sessions")
    def sl(h, m, q, a):
        return [s.info() for s in d.sessions.values()]

    @route("GET", r"/v1/sessions/(\w+)")
    def sg(h, m, q, a):
        return d.get_session(m.group(1)).info()

    @route("DELETE", r"/v1/sessions/(\w+)")
    def sd(h, m, q, a):
        s = d.get_session(m.group(1))
        s.close()
        d.sessions.pop(s.id, None)
        return {"closed": True}

    @route("POST", r"/v1/sessions/(\w+)/exec")
    def se(h, m, q, a):
        return d.api_session_exec(m.group(1), a)

    @route("POST", r"/v1/sessions/(\w+)/stdin")
    def si(h, m, q, a):
        d.get_session(m.group(1)).stdin(b64(a))
        return {"written": True}

    @route("POST", r"/v1/sessions/(\w+)/interrupt")
    def sint(h, m, q, a):
        d.get_session(m.group(1)).interrupt()
        return {"sent": "ETX"}

    @route("POST", r"/v1/sessions/(\w+)/cancel")
    def scan(h, m, q, a):
        return d.get_session(m.group(1)).cancel()

    @route("POST", r"/v1/sessions/(\w+)/resize")
    def sre(h, m, q, a):
        d.get_session(m.group(1)).resize(int(a.get("cols", 80)), int(a.get("rows", 24)))
        return {}

    @route("POST", r"/v1/sessions/(\w+)/restart")
    def srs(h, m, q, a):
        s = d.get_session(m.group(1))
        s.restart("requested")
        return s.info()

    @route("GET", r"/v1/sessions/(\w+)/events")
    def sev(h, m, q, a):
        s = d.get_session(m.group(1))
        return s.log.read(int(q.get("since", ["0"])[0]), min(int(q.get("wait_ms", ["0"])[0]), 30000), int(q.get("limit", ["2000"])[0]))

    def _svc(obj, name, prefix):
        route("POST", prefix + name.replace("_", "-"))(lambda h, m, q, a, _o=obj, _n=name: getattr(_o, _n)(a))

    for n in ("init", "status", "diff", "log", "branch", "checkout", "add", "restore", "commit", "fetch", "pull", "push", "stash", "rev_parse", "clone"):
        _svc(d.git, n, "/v1/git/")
    for n in ("create", "list", "inspect", "rollback", "delete"):
        _svc(d.snap, n, "/v1/snapshots/")
    for n in ("start", "send", "resume", "cancel", "status", "models", "probe"):
        _svc(d.agent, n, "/v1/agent/")

    @route("POST", r"/v1/maintenance/cleanup")
    def maint(h, m, q, a):
        tmp = old = 0
        now = time.time()
        for p in fs.projects():
            root = os.path.join(d.ws.root, p["id"])
            for dp, dn, fn in os.walk(root):
                dn[:] = [x for x in dn if x not in ("node_modules", ".git")]
                for f in fn:
                    if f.startswith(".oc-") and f.endswith(".tmp"):
                        try:
                            os.unlink(os.path.join(dp, f)); tmp += 1
                        except OSError:
                            pass
        ad = os.path.join(d.ws.root, ".oc-agent")
        for f in os.listdir(ad) if os.path.isdir(ad) else []:
            fp = os.path.join(ad, f)
            try:
                if now - os.stat(fp).st_mtime > 14 * 86400:
                    os.unlink(fp); old += 1
            except OSError:
                pass
        return {"tmp_files": tmp, "old_agent_sessions": old}

    @route("POST", r"/v1/projects/detect")
    def pdet(h, m, q, a):
        return ocd_detect.detect(d.ws.project_dir(a.get("project")))

    @route("POST", r"/v1/jobs")
    def jc(h, m, q, a):
        project = a.get("project")
        root = d.ws.project_dir(project)
        _, cwd, _ = d.ws.resolve(project, a.get("cwd", ""), must_exist=True)
        if a.get("session_id") and not a.get("cwd"):
            s = d.get_session(a["session_id"])
            if os.path.isdir(s.cwd):
                cwd = s.cwd
        argv, cmd = a.get("argv"), a.get("command")
        if (argv is None) == (cmd is None):
            raise ApiError("INVALID_ARGUMENT", "Provide exactly one of argv or command.", 400)
        if argv is not None and (not isinstance(argv, list) or not argv or not all(isinstance(x, str) and "\0" not in x for x in argv)):
            raise ApiError("INVALID_ARGUMENT", "argv must be a non-empty list of strings.", 400)
        if cmd is not None:
            if not isinstance(cmd, str) or not cmd.strip():
                raise ApiError("INVALID_ARGUMENT", "command must be a non-empty string.", 400)
            pol = Policy.assess(cmd)
        else:
            pol = Policy.assess_argv(argv)
        if pol["level"] == "deny":
            raise ApiError("COMMAND_DENIED", "This command is blocked: " + "; ".join(pol["reasons"]), 403, pol["reasons"])
        if pol["level"] == "confirm" and not a.get("confirmed"):
            raise ApiError("CONFIRMATION_REQUIRED", "This command needs confirmation: " + "; ".join(pol["reasons"]), 409, pol["reasons"])
        env = d.base_env()
        env.update(d.clean_env(a.get("env")))
        env.setdefault("TERM", "dumb")
        jid = "j" + uuid.uuid4().hex[:10]
        job = Job(d, jid, argv, cmd, cwd, env, int(a.get("timeout_ms", 0) or 0), bool(a.get("stdin")), project)
        with d.lock:
            d.jobs[jid] = job
        return job.info()

    @route("GET", r"/v1/jobs")
    def jl(h, m, q, a):
        return [j.info() for j in d.jobs.values()]

    @route("GET", r"/v1/jobs/(\w+)")
    def jg(h, m, q, a):
        return d.get_job(m.group(1)).info()

    @route("GET", r"/v1/jobs/(\w+)/events")
    def jev(h, m, q, a):
        return d.get_job(m.group(1)).log.read(int(q.get("since", ["0"])[0]), min(int(q.get("wait_ms", ["0"])[0]), 30000), int(q.get("limit", ["2000"])[0]))

    @route("POST", r"/v1/jobs/(\w+)/stdin")
    def jsi(h, m, q, a):
        d.get_job(m.group(1)).stdin(b64(a), bool(a.get("close")))
        return {"written": True}

    @route("POST", r"/v1/jobs/(\w+)/cancel")
    def jca(h, m, q, a):
        return d.get_job(m.group(1)).cancel()

    class H(BaseHTTPRequestHandler):
        timeout = d.io_timeout              # socket read timeout: slow/lying clients cannot pin a thread
        protocol_version = "HTTP/1.1"
        server_version = "ocd"
        sys_version = ""

        def log_message(self, fmt, *args):      # never log URLs/headers/bodies (may hold paths or tokens)
            pass

        def _send(self, status, obj):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _handle(self, method):
            rid = self.headers.get("X-Request-Id", "")[:64] or uuid.uuid4().hex[:12]
            try:
                host = (self.headers.get("Host") or "").lower()
                if host not in ("127.0.0.1:%d" % d.port, "localhost:%d" % d.port, "[::1]:%d" % d.port):
                    raise ApiError("BAD_HOST", "Unexpected Host header.", 403)
                if self.headers.get("Origin") is not None:
                    raise ApiError("FORBIDDEN_ORIGIN", "Browser-originated requests are not accepted.", 403)
                auth = self.headers.get("Authorization", "")
                tok = auth[7:] if auth.startswith("Bearer ") else ""
                if not hmac.compare_digest(tok.encode(), d.token.encode()):
                    time.sleep(0.25)
                    raise ApiError("UNAUTHORIZED", "Missing or invalid token.", 401)
                u = urlparse(self.path)
                q = parse_qs(u.query)
                body = {}
                if method in ("POST", "DELETE"):
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > MAX_BODY:
                        self.close_connection = True
                        raise ApiError("PAYLOAD_TOO_LARGE", "Request body too large.", 413)
                    raw = self.rfile.read(n) if n else b""
                    if raw:
                        try:
                            body = json.loads(raw)
                        except ValueError:
                            raise ApiError("BAD_JSON", "Body is not valid JSON.", 400)
                        if not isinstance(body, dict):
                            raise ApiError("BAD_JSON", "Body must be a JSON object.", 400)
                matched = False
                for meth, rx, fn in ROUTES:
                    mt = rx.match(u.path)
                    if mt:
                        matched = True
                        if meth == method:
                            data = fn(self, mt, q, body)
                            return self._send(200, {"success": True, "data": data, "error": None, "requestId": rid})
                if matched:
                    raise ApiError("METHOD_NOT_ALLOWED", "Method not allowed.", 405)
                raise ApiError("UNKNOWN_ROUTE", "No such endpoint.", 404)
            except ApiError as e:
                self._send(e.status, {"success": False, "data": None, "requestId": rid,
                                      "error": {"code": e.code, "message": e.message, "details": e.details}})
            except (ValueError, TypeError) as e:
                self._send(400, {"success": False, "data": None, "requestId": rid,
                                 "error": {"code": "INVALID_ARGUMENT", "message": "Invalid argument.", "details": type(e).__name__}})
            except BrokenPipeError:
                pass
            except Exception as e:      # never leak internals/tracebacks to the client
                sys.stderr.write("internal error: %s\n" % type(e).__name__)
                self._send(500, {"success": False, "data": None, "requestId": rid,
                                 "error": {"code": "INTERNAL", "message": "Unexpected daemon error.", "details": type(e).__name__}})

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_DELETE(self):
            self._handle("DELETE")

    return H

