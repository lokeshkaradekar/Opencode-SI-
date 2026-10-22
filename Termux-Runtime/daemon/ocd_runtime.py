"""Daemon state, session/job registry, watchdog and process orchestration."""
import collections
import os
import signal
import threading
import time
import uuid
import ocd_agent
import ocd_detect
import ocd_git
import ocd_snap
from ocd_config import ENV_RE
from ocd_errors import ApiError
from ocd_policy import Policy
from ocd_processes import Session, Job
from ocd_filesystem import FS
from ocd_workspace import Workspace

class Daemon:
    def __init__(self, workspace, token):
        self.ws = Workspace(workspace)
        self.token = token
        self.sessions = {}
        self.jobs = collections.OrderedDict()
        self.lock = threading.RLock()
        self.started = time.time()
        self.port = None
        self.io_timeout = 30
        self._stop = threading.Event()
        self.git = ocd_git.GitService(self.ws, ApiError)
        self.snap = ocd_snap.SnapshotService(self.ws, ApiError)
        self.agent = ocd_agent.AgentService(self, FS(self.ws), self.snap, ocd_detect.detect, ApiError)
        threading.Thread(target=self._watchdog, daemon=True, name="watchdog").start()

    def base_env(self):
        env = {k: v for k, v in os.environ.items() if k not in ("OC_DAEMON_TOKEN",) and not k.startswith("OC_DAEMON")}
        env.setdefault("HOME", os.path.expanduser("~"))
        # a hostile repository's .git/config must not be able to run code through the terminal's own git
        env.update({"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.fsmonitor", "GIT_CONFIG_VALUE_0": "false",
                    "GIT_CONFIG_KEY_1": "protocol.ext.allow", "GIT_CONFIG_VALUE_1": "never", "GIT_TERMINAL_PROMPT": "0"})
        return env

    def _watchdog(self):
        while not self._stop.wait(0.1):
            now = time.time()
            with self.lock:
                items = list(self.sessions.values()) + list(self.jobs.values())
            for it in items:
                try:
                    it.tick(now)
                except Exception:
                    pass
            with self.lock:   # keep the last 50 finished jobs
                done = [k for k, j in self.jobs.items() if j.state != "RUNNING"]
                for k in done[:-50]:
                    self.jobs.pop(k, None)

    def get_session(self, sid):
        s = self.sessions.get(sid)
        if not s:
            raise ApiError("NOT_FOUND", "No such session.", 404)
        return s

    def get_job(self, jid):
        j = self.jobs.get(jid)
        if not j:
            raise ApiError("NOT_FOUND", "No such job.", 404)
        return j

    def clean_env(self, extra):
        out = {}
        for k, v in (extra or {}).items():
            if not isinstance(k, str) or not ENV_RE.match(k) or k.startswith("OC_") or not isinstance(v, str) or "\0" in v:
                raise ApiError("INVALID_ARGUMENT", "Invalid environment variable: %r" % (k,), 400)
            out[k] = v
        return out

    def shutdown(self):
        self._stop.set()
        for s in list(self.sessions.values()):
            s.close()
        for j in list(self.jobs.values()):
            if j.state == "RUNNING":
                j._signal(signal.SIGKILL)

    def run_job_sync(self, project, command, timeout_ms, cancel_ev=None, source="user", cap=20000):
        """Run a shell command as a real process (pipe mode), wait for it, return its real result.
        Same Policy as the terminal: deny -> error, confirm -> error (a non-interactive caller cannot confirm)."""
        root = self.ws.project_dir(project)
        pol = Policy.assess(command)
        if pol["level"] == "deny":
            raise ApiError("COMMAND_DENIED", "This command is blocked: " + "; ".join(pol["reasons"]), 403, pol["reasons"])
        if pol["level"] == "confirm":
            raise ApiError("CONFIRMATION_REQUIRED", "This command needs the user's confirmation (%s). Ask the user to run it themselves in the terminal." % "; ".join(pol["reasons"]), 409, pol["reasons"])
        env = self.base_env()
        env.setdefault("TERM", "dumb")
        env["CI"] = "1"
        jid = "j" + uuid.uuid4().hex[:10]
        job = Job(self, jid, None, command, root, env, int(timeout_ms or 0), False, project)
        with self.lock:
            self.jobs[jid] = job
        while job.state == "RUNNING":
            if cancel_ev is not None and cancel_ev.is_set():
                job.cancel()
            time.sleep(0.05)
        for t in job.readers:
            t.join(2)
        out, err, since = [], [], 0
        while True:
            r = job.log.read(since, 0)
            for ev in r["events"]:
                if ev["type"] == "output":
                    (out if ev["stream"] == "stdout" else err).append(ev["data"])
            if not r["events"] or r["next"] <= since:
                break
            since = r["next"]
        so, se = "".join(out), "".join(err)
        return {"status": job.state, "exit_code": job.exit_code, "stdout": so[-cap:], "stderr": se[-cap:], "id": jid}

    # ---- API: sessions
    def api_session_create(self, a):
        root = self.ws.project_dir(a.get("project"))
        _, full, rel = self.ws.resolve(a.get("project"), a.get("cwd", ""), must_exist=True)
        if not os.path.isdir(full):
            raise ApiError("NOT_DIRECTORY", "cwd is not a directory.", 400)
        cols = int(a.get("cols", 80)); rows = int(a.get("rows", 24))
        if not (10 <= cols <= 500 and 2 <= rows <= 300):
            raise ApiError("INVALID_ARGUMENT", "Bad terminal size.", 400)
        sid = "s" + uuid.uuid4().hex[:10]
        s = Session(self, sid, a["project"], root, rel, self.clean_env(a.get("env")), cols, rows)
        with self.lock:
            self.sessions[sid] = s
        return s.info()

    def api_session_exec(self, sid, a):
        s = self.get_session(sid)
        cmd = a.get("command")
        if not isinstance(cmd, str) or not cmd.strip():
            raise ApiError("INVALID_ARGUMENT", "command is required.", 400)
        pol = Policy.assess(cmd)
        if pol["level"] == "deny":
            raise ApiError("COMMAND_DENIED", "This command is blocked: " + "; ".join(pol["reasons"]), 403, pol["reasons"])
        if pol["level"] == "confirm" and not a.get("confirmed"):
            raise ApiError("CONFIRMATION_REQUIRED", "This command needs confirmation: " + "; ".join(pol["reasons"]), 409, pol["reasons"])
        return s.exec(cmd, int(a.get("timeout_ms", 0) or 0), a.get("source", "user"))

