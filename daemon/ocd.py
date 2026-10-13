#!/usr/bin/env python3
"""ocd.py - OpenCode SI execution daemon (runs inside Termux, stdlib only).

Provides, over an authenticated loopback-only HTTP/JSON API:
  * persistent PTY shell sessions (cd persists, Ctrl+C, stdin, timeouts, lifecycle)
  * pipe-mode jobs with separate stdout/stderr (tests, builds, long-running servers)
  * a project-confined filesystem API
  * real health probes

Every reply uses the bridge envelope: {success, data, error:{code,message,details}, requestId}.
Requires: python3, bash. Nothing is simulated: all state comes from real processes.
"""
import argparse
import base64
import codecs
import collections
import fcntl
import hmac
import json
import os
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ocd_agent
import ocd_detect
import ocd_git
import ocd_snap

VERSION = "0.2.0"
MAX_BODY = 16 * 1024 * 1024
MAX_READ_DEFAULT = 1024 * 1024
MAX_READ_HARD = 8 * 1024 * 1024
MAX_WRITE = 8 * 1024 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
HDR = b"\x1b]777;OC;"


# ------------------------------------------------------------------ errors
class ApiError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


def os_error(e, what=""):
    import errno as E
    m = {E.ENOENT: ("NOT_FOUND", 404), E.EACCES: ("PERMISSION_DENIED", 403), E.EPERM: ("PERMISSION_DENIED", 403),
         E.EEXIST: ("ALREADY_EXISTS", 409), E.ENOTEMPTY: ("NOT_EMPTY", 409), E.ENOSPC: ("STORAGE_FULL", 507),
         E.EISDIR: ("IS_DIRECTORY", 400), E.ENOTDIR: ("NOT_DIRECTORY", 400), E.ELOOP: ("SYMLINK_LOOP", 400),
         E.ETXTBSY: ("FILE_LOCKED", 423), E.EBUSY: ("FILE_LOCKED", 423), E.EROFS: ("READ_ONLY", 403),
         E.ENAMETOOLONG: ("INVALID_PATH", 400)}
    code, st = m.get(e.errno, ("IO_ERROR", 500))
    return ApiError(code, (what + ": " if what else "") + (e.strerror or str(e)), st, "errno=%s" % e.errno)


# ------------------------------------------------------------------ redaction
_REDACT = [
    (re.compile(r"(://)[^/\s:@]+:[^@\s/]+@"), r"\1***:***@"),
    (re.compile(r"\b(sk-[A-Za-z0-9_-]{16,})"), "sk-***"),
    (re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,})"), "gh_***"),
    (re.compile(r"(?i)(authorization:\s*bearer\s+)\S+"), r"\1***"),
    (re.compile(r"(?i)\b((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)(?!\*)[^\s'\"&]{6,}"), r"\1***"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"), "[private key redacted]"),
]


def redact(s):
    for rx, rep in _REDACT:
        s = rx.sub(rep, s)
    return s


# ------------------------------------------------------------------ command policy
class Policy:
    """Permission model: classify a command line as ok / confirm / deny.
    This is a safety rail for accidents and for AI-proposed commands. It is NOT a sandbox:
    the shell is as powerful as the Termux user. The security boundary is auth + loopback."""
    SEG = re.compile(r"\|\||&&|;|\||&|\n")
    WRAPPERS = {"sudo", "doas", "env", "command", "nohup", "time", "exec", "nice", "xargs"}

    @staticmethod
    def assess_argv(argv):
        """Policy for a no-shell argv. Literal arguments are never re-parsed; a shell -c payload is."""
        base = os.path.basename(argv[0]) if argv else ""
        if base in ("bash", "sh", "zsh", "dash") and "-c" in argv[1:]:
            i = argv.index("-c")
            if i + 1 < len(argv):
                return Policy.assess(argv[i + 1])
        confirm, deny = [], []
        Policy._tokens(list(argv), confirm, deny)
        return {"level": "deny" if deny else ("confirm" if confirm else "ok"), "reasons": deny or confirm}

    @staticmethod
    def assess(cmd):
        confirm, deny = [], []
        if re.search(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:", cmd):
            deny.append("fork bomb")
        if re.search(r"\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b", cmd):
            confirm.append("pipes a download into a shell")
        if re.search(r">\s*/dev/(sd|mmcblk|nvme|block)", cmd):
            deny.append("writes directly to a block device")
        for seg in Policy.SEG.split(cmd):
            try:
                t = shlex.split(seg)
            except ValueError:
                t = seg.split()
            Policy._tokens(t, confirm, deny)
        return {"level": "deny" if deny else ("confirm" if confirm else "ok"), "reasons": deny or confirm}


    @staticmethod
    def _tokens(t, confirm, deny):
        while t and (t[0] in Policy.WRAPPERS or "=" in t[0] and not t[0].startswith("-")):
            t = t[1:]
        if not t:
            return
        c, a = os.path.basename(t[0]), t[1:]
        flags = [x for x in a if x.startswith("-")]
        args = [x for x in a if not x.startswith("-")]
        if c == "rm":
            rec = any(f == "--recursive" or (not f.startswith("--") and re.search(r"[rR]", f)) for f in flags)
            force = any(f == "--force" or (not f.startswith("--") and "f" in f) for f in flags)
            if rec and any(x in ("/", "/*", "~", "~/", "$HOME", "${HOME}", "/data", "/data/data") or x.rstrip("/") in ("/data/data/com.termux", "/data/data/com.termux/files") for x in args):
                deny.append("recursive delete of a system or home directory")
            elif rec or force:
                confirm.append("rm with " + ("recursive" if rec else "force") + " flag deletes data")
            else:
                confirm.append("rm deletes files")
        elif c == "git" and a:
            sub = next((x for x in a if not x.startswith("-")), "")
            rest = a[a.index(sub) + 1:] if sub in a else []
            if sub == "reset" and "--hard" in rest:
                confirm.append("git reset --hard discards uncommitted work")
            elif sub == "clean" and not any(x in ("-n", "--dry-run") for x in rest):
                confirm.append("git clean deletes untracked files")
            elif sub == "push" and any(x in ("--force", "-f", "--force-with-lease", "--delete", "-d", "--mirror") or x.startswith("+") for x in rest):
                confirm.append("force/destructive git push rewrites remote history")
            elif sub == "checkout" and ("--" in rest or "." in rest):
                confirm.append("git checkout discards local changes")
            elif sub == "restore" and "--staged" not in rest:
                confirm.append("git restore discards local changes")
            elif sub == "branch" and any(x in ("-D", "--delete", "-d") for x in rest):
                confirm.append("deletes a git branch")
            elif sub == "stash" and rest[:1] in (["drop"], ["clear"]):
                confirm.append("drops stashed work")
            elif sub in ("filter-branch", "reflog") and sub == "filter-branch":
                confirm.append("rewrites git history")
        elif c == "dd" and any(x.startswith("of=") for x in a):
            confirm.append("dd writes raw data")
        elif c.startswith("mkfs") or c in ("fdisk", "parted", "wipefs", "sfdisk", "shred"):
            deny.append("disk/partition operation")
        elif c in ("shutdown", "reboot", "halt", "poweroff"):
            confirm.append("powers off the device")
        elif c in ("chmod", "chown", "chgrp"):
            if any(f in ("-R", "--recursive") for f in flags) or any(x in ("/", "~") for x in args):
                confirm.append(c + " changes permissions/ownership recursively")
            else:
                confirm.append(c + " changes permissions/ownership")
        elif c == "kill" and any(x in ("-1", "-9") for x in a) and "-1" in a:
            confirm.append("kill -1 signals every process")
        elif c == "mv" and any(x == "/dev/null" for x in args):
            confirm.append("moves data to /dev/null")


# ------------------------------------------------------------------ event log
class EventLog:
    """Ordered, size-capped event log with cursor + long-poll reads."""

    def __init__(self, cap_bytes=4 * 1024 * 1024):
        self.cv = threading.Condition()
        self.items = collections.deque()
        self.sizes = collections.deque()
        self.seq = 0
        self.total = 0
        self.cap = cap_bytes

    def append(self, type_, **fields):
        with self.cv:
            self.seq += 1
            ev = {"seq": self.seq, "t": round(time.time(), 3), "type": type_}
            ev.update(fields)
            sz = 96 + len(fields.get("data", ""))
            self.items.append(ev)
            self.sizes.append(sz)
            self.total += sz
            while self.total > self.cap and len(self.items) > 1:
                self.items.popleft()
                self.total -= self.sizes.popleft()
            self.cv.notify_all()
            return ev

    def read(self, since=0, wait_ms=0, limit=2000):
        deadline = time.time() + wait_ms / 1000.0
        with self.cv:
            while self.seq <= since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cv.wait(left)
            first = self.items[0]["seq"] if self.items else self.seq + 1
            truncated = since + 1 < first and self.seq > since
            start = max(0, since + 1 - first)
            evs = [self.items[i] for i in range(start, min(len(self.items), start + limit))]
            nxt = evs[-1]["seq"] if evs else max(since, self.seq if not self.items else since)
            if not evs and self.seq > since:
                nxt = self.seq
            return {"events": evs, "next": nxt, "truncated": truncated, "latest": self.seq}


# ------------------------------------------------------------------ workspace
class Workspace:
    """Maps project names to directories. Local Termux implementation; a remote backend would
    implement the same methods against another host. Callers never see absolute paths as input."""

    def __init__(self, root):
        self.root = os.path.realpath(os.path.expanduser(root))
        os.makedirs(self.root, exist_ok=True)
        self._external_map_file = os.path.join(self.root, ".si-project-paths.json")
        self._external_projects = {}
        try:
            with open(self._external_map_file, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for key, value in raw.items():
                    if isinstance(key, str) and NAME_RE.match(key) and not key.startswith(".") and isinstance(value, str):
                        path = os.path.realpath(value)
                        if os.path.isdir(path) and not os.path.islink(value):
                            self._external_projects[key] = path
        except (OSError, ValueError, TypeError):
            pass

    def _save_external_projects(self):
        tmp = self._external_map_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._external_projects, f, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, self._external_map_file)

    def _validate_external_parent(self, value):
        if not isinstance(value, str) or "\0" in value:
            raise ApiError("INVALID_PATH", "Choose a valid project parent folder.", 400)
        parent = os.path.realpath(os.path.expanduser(value.strip()))
        home = os.path.realpath(os.path.expanduser("~"))
        shared = os.path.realpath("/storage/emulated/0")
        allowed_home = parent == home or parent.startswith(home + os.sep)
        allowed_shared = parent == shared or parent.startswith(shared + os.sep)
        if not (allowed_home or allowed_shared) or os.path.islink(value):
            raise ApiError("INVALID_PATH", "Choose a folder inside Termux home or shared internal storage.", 400)
        if not os.path.isdir(parent):
            if allowed_shared:
                raise ApiError("STORAGE_PERMISSION_REQUIRED",
                               "Termux cannot access this phone-storage folder. In Termux, run termux-setup-storage and grant storage access, then fully restart Termux and retry.",
                               403)
            raise ApiError("INVALID_PATH", "The selected folder does not exist or is not accessible to Termux.", 400)
        return parent

    def project_dir(self, name):
        if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith("."):
            raise ApiError("INVALID_ARGUMENT", "Invalid project name.", 400)
        p = self._external_projects.get(name, os.path.join(self.root, name))
        if not os.path.isdir(p):
            raise ApiError("NOT_FOUND", "Project not found: %s" % name, 404)
        return os.path.realpath(p)

    @staticmethod
    def norm(rel):
        if rel is None:
            rel = ""
        if not isinstance(rel, str) or "\0" in rel:
            raise ApiError("INVALID_PATH", "Invalid path.", 400)
        parts = []
        for s in rel.replace("\\", "/").split("/"):
            if s in ("", "."):
                continue
            if s == "..":
                if not parts:
                    raise ApiError("PATH_OUTSIDE_PROJECT", "That path is outside the project folder.", 403)
                parts.pop()
            else:
                parts.append(s)
        return parts

    def resolve(self, project, rel, must_exist=False):
        root = self.project_dir(project)
        parts = self.norm(rel)
        full = os.path.realpath(os.path.join(root, *parts))
        if full != root and not full.startswith(root + os.sep):
            raise ApiError("PATH_OUTSIDE_PROJECT", "That path is outside the project folder.", 403)
        if must_exist and not os.path.lexists(full):
            raise ApiError("NOT_FOUND", "Not found: %s" % "/".join(parts), 404)
        return root, full, "/".join(parts)

    def relpath(self, root, full):
        r = os.path.relpath(full, root)
        return "" if r == "." else r.replace(os.sep, "/")


# ------------------------------------------------------------------ PTY session
class Session:
    def __init__(self, daemon, sid, project, root, start_rel, env_extra, cols, rows):
        self.d, self.id, self.project, self.root = daemon, sid, project, root
        self.log = EventLog()
        self.lock = threading.RLock()
        self.env_extra = env_extra
        self.cols, self.rows = cols, rows
        self.cwd = os.path.realpath(os.path.join(root, *Workspace.norm(start_rel)))
        self.state = "starting"   # starting | idle | running | exited
        self.current = None
        self.history = collections.deque(maxlen=50)
        self.counter = 0
        self.master = None
        self.proc = None
        self.gen = 0
        self.restarts = 0
        self.created = time.time()
        self.nonce = secrets.token_hex(12)
        self.tmp = tempfile.mkdtemp(prefix="ocd-sess-")
        os.chmod(self.tmp, 0o700)
        self.pending = b""
        self.dec = None
        self.initial_pending = True
        self.ready = threading.Event()
        self.start()

    # -- lifecycle
    def start(self, wait=True):
        bash = shutil.which("bash")
        if not bash:
            raise ApiError("SHELL_UNAVAILABLE", "bash is not installed (pkg install bash).", 500)
        if not os.path.isdir(self.cwd):
            self.cwd = self.root
        rc = os.path.join(self.tmp, "rc.sh")
        with open(rc, "w") as f:
            f.write("set +H\nunset HISTFILE\nset +o history 2>/dev/null\nPS1=''; PS2=''; PS3=''\n"
                    "__oc_pc() { local __ec=$?; printf '\\033]777;OC;%s;%d;%s\\007' '" + self.nonce + "' \"$__ec\" \"$PWD\"; return $__ec; }\n"
                    "PROMPT_COMMAND=__oc_pc\n")
        os.chmod(rc, 0o600)
        master, slave = os.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[1] &= ~termios.ONLCR          # keep \n as \n
        attrs[3] &= ~(termios.ECHO | termios.ECHOE | termios.ECHOK | termios.ECHONL | termios.ECHOCTL)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
        env = self.d.base_env()
        env.update({"TERM": "xterm-256color", "COLUMNS": str(self.cols), "LINES": str(self.rows), "OC_SESSION": self.id})
        env.update(self.env_extra)

        def pre():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.pending = b""
        self.initial_pending = True      # the first prompt marker is "shell ready", never a command result
        self.ready.clear()
        self.proc = subprocess.Popen([bash, "--noediting", "--noprofile", "--rcfile", rc, "-i"], stdin=slave, stdout=slave,
                                     stderr=slave, preexec_fn=pre, cwd=self.cwd, env=env, close_fds=True)
        os.close(slave)
        self.master = master
        self.gen += 1
        self.state = "starting"
        self.log.append("session_start", pid=self.proc.pid, cwd=self.cwd, restarts=self.restarts)
        threading.Thread(target=self._reader, args=(master, self.proc, self.gen), daemon=True, name="pty-reader").start()
        if wait and not self.ready.wait(10):
            raise ApiError("SHELL_START_FAILED", "The shell did not become ready in 10s.", 500)

    def restart(self, reason="requested"):
        # Called with self.lock held (exec) or not (API): never block on readiness here, because the
        # reader thread needs this lock to deliver the first prompt. Input written meanwhile is
        # buffered by the tty until bash reads it.
        with self.lock:
            self._kill_shell()
            self.restarts += 1
            self.log.append("session_restart", reason=reason)
            self.start(wait=False)

    def _kill_shell(self):
        p = self.proc
        if p and p.poll() is None:
            for sig in (signal.SIGHUP, signal.SIGKILL):
                try:
                    os.killpg(p.pid, sig)
                except OSError:
                    pass
                try:
                    p.wait(1.0)
                    break
                except subprocess.TimeoutExpired:
                    continue
        try:
            if self.master is not None:
                os.close(self.master)
        except OSError:
            pass
        self.master = None
        self.gen += 1

    def close(self):
        with self.lock:
            self._kill_shell()
            self.state = "exited"
            shutil.rmtree(self.tmp, ignore_errors=True)

    # -- reader / marker parser
    def _reader(self, master, proc, gen):
        while True:
            try:
                r, _, _ = select.select([master], [], [], 0.4)
            except (OSError, ValueError):
                break
            if gen != self.gen:
                return
            if not r:
                self._idle_flush(gen)
                if proc.poll() is not None:
                    break
                continue
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            self._feed(data, gen)
        if gen == self.gen:
            self._on_exit(proc, gen)

    def _emit(self, raw, flush=False):
        text = self.dec.decode(raw, final=flush)
        if text:
            cur = self.current
            self.log.append("output", stream="pty", cmd=cur["id"] if cur else None, data=redact(text))

    def _idle_flush(self, gen):
        with self.lock:
            if gen == self.gen and self.pending and HDR not in self.pending:
                raw, self.pending = self.pending, b""
                self._emit(raw)

    def _feed(self, data, gen):
        with self.lock:
            if gen != self.gen:
                return
            buf = self.pending + data
            self.pending = b""
            while True:
                i = buf.find(HDR)
                if i < 0:
                    hold = 0
                    for k in range(min(len(HDR) - 1, len(buf)), 0, -1):
                        if buf.endswith(HDR[:k]):
                            hold = k
                            break
                    if len(buf) - hold:
                        self._emit(buf[:len(buf) - hold])
                    self.pending = buf[len(buf) - hold:]
                    return
                if i:
                    self._emit(buf[:i])
                j = buf.find(b"\x07", i)
                if j < 0:
                    if len(buf) - i > 8192:       # never terminated: not our marker
                        self._emit(buf[i:i + len(HDR)])
                        buf = buf[i + len(HDR):]
                        continue
                    self.pending = buf[i:]
                    return
                body = buf[i + len(HDR):j].decode("utf-8", "replace")
                buf = buf[j + 1:]
                parts = body.split(";", 2)
                if len(parts) == 3 and hmac.compare_digest(parts[0], self.nonce) and re.fullmatch(r"-?\d+", parts[1]):
                    self._on_prompt(int(parts[1]), parts[2])
                else:
                    self._emit(HDR + body.encode() + b"\x07")

    def _on_prompt(self, ec, cwd):
        self.cwd = cwd
        if self.initial_pending:
            self.initial_pending = False
            self.state = "running" if self.current else "idle"
            self.log.append("ready", cwd=cwd)
            self.ready.set()
            return
        cur = self.current
        if cur is not None:
            self._finish(cur, ec, cwd)

    def _finish(self, cur, ec, cwd, shell_exited=False):
        if cur["timed_out"]:
            status = "TIMEOUT"
        elif cur["cancelled"] or ec in (130,) or (ec in (137, 143) and not shell_exited and cur["sig_stage"]):
            status = "CANCELLED"
        elif ec == 0:
            status = "SUCCESS"
        else:
            status = "FAILED"
        cur.update(status=status, exit_code=ec, ended=time.time(), cwd_after=cwd, shell_exited=shell_exited)
        self.current = None
        if not shell_exited:
            self.state = "idle"
        self.history.append({k: cur[k] for k in ("id", "command", "status", "exit_code", "started", "ended", "cwd_after")})
        self.log.append("command_end", cmd=cur["id"], status=status, exit_code=ec, cwd=cwd,
                        duration_ms=int((cur["ended"] - cur["started"]) * 1000), shell_exited=shell_exited)
        try:
            os.unlink(cur["script"])
        except OSError:
            pass

    def _on_exit(self, proc, gen):
        try:
            code = proc.wait(2)
        except subprocess.TimeoutExpired:
            code = -1
        with self.lock:
            if gen != self.gen:
                return
            if self.pending:
                self._emit(self.pending, flush=True)
                self.pending = b""
            sig = -code if code is not None and code < 0 else None
            ec = (128 + sig) if sig else code
            self.log.append("session_exit", exit_code=ec, signal=sig)
            cur = self.current
            if cur:
                self._finish(cur, ec if ec is not None else 1, self.cwd, shell_exited=True)
            self.state = "exited"
            self.ready.set()

    # -- operations
    def exec(self, command, timeout_ms=0, source="user"):
        with self.lock:
            if self.state == "exited":
                self.restart("auto-recover before exec")
            if self.current is not None:
                raise ApiError("BUSY", "A command is already running in this session.", 409,
                               "command #%d" % self.current["id"])
            if "\0" in command:
                raise ApiError("INVALID_ARGUMENT", "Command contains a NUL byte.", 400)
            self.counter += 1
            n = self.counter
            script = os.path.join(self.tmp, "cmd-%d.sh" % n)
            with open(script, "w") as f:
                f.write(command + "\n")
            os.chmod(script, 0o600)
            now = time.time()
            cur = {"id": n, "command": redact(command), "status": "RUNNING", "exit_code": None, "started": now,
                   "ended": None, "deadline": (now + timeout_ms / 1000.0) if timeout_ms else None,
                   "timed_out": False, "cancelled": False, "sig_stage": 0, "sig_t0": 0, "script": script,
                   "source": source}
            self.current = cur
            self.state = "running"
            self.log.append("command_start", cmd=n, command=cur["command"], cwd=self.cwd, source=source)
            # `source` runs inside the persistent shell, so cd / export / aliases persist.
            os.write(self.master, ("source %s\n" % shlex.quote(script)).encode())
            return {"id": n, "status": "RUNNING", "seq": self.log.seq}

    def stdin(self, data):
        with self.lock:
            if self.master is None or self.state == "exited":
                raise ApiError("SESSION_EXITED", "The shell has exited.", 409)
            os.write(self.master, data)

    def interrupt(self):
        """Exactly what pressing Ctrl+C does: ETX to the tty; the line discipline raises SIGINT."""
        with self.lock:
            if self.master is None or self.state == "exited":
                raise ApiError("SESSION_EXITED", "The shell has exited.", 409)
            os.write(self.master, b"\x03")

    def cancel(self):
        with self.lock:
            cur = self.current
            if cur is None:
                return {"cancelled": False, "reason": "no running command"}
            cur["cancelled"] = True
            if not cur["sig_stage"]:
                cur["sig_stage"], cur["sig_t0"] = 1, time.time()
            os.write(self.master, b"\x03")
            return {"cancelled": True, "cmd": cur["id"]}

    def resize(self, cols, rows):
        with self.lock:
            self.cols, self.rows = cols, rows
            if self.master is not None:
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def tick(self, now):
        """Called by the watchdog: enforce timeouts and escalate INT -> TERM -> KILL."""
        with self.lock:
            cur = self.current
            if cur is None or self.master is None:
                return
            if cur["deadline"] and now > cur["deadline"] and not cur["timed_out"]:
                cur["timed_out"] = True
                if not cur["sig_stage"]:
                    cur["sig_stage"], cur["sig_t0"] = 1, now
                try:
                    os.write(self.master, b"\x03")
                except OSError:
                    pass
            if cur["sig_stage"]:
                el = now - cur["sig_t0"]
                try:
                    fg = os.tcgetpgrp(self.master)
                except OSError:
                    fg = None
                if fg and el > 1.5 and cur["sig_stage"] == 1:
                    cur["sig_stage"] = 2
                    self._sig(fg, signal.SIGINT if fg != self.proc.pid else signal.SIGINT)
                    self._sig(fg, signal.SIGTERM)
                elif fg and el > 3.5 and cur["sig_stage"] == 2:
                    cur["sig_stage"] = 3
                    self._sig(fg, signal.SIGKILL)
                elif el > 6 and cur["sig_stage"] == 3:
                    cur["sig_stage"] = 4
                    self._sig(self.proc.pid, signal.SIGKILL)   # shell itself is stuck: crash-recover below

    @staticmethod
    def _sig(pg, sig):
        try:
            os.killpg(pg, sig)
        except OSError:
            pass

    def info(self):
        with self.lock:
            cur = self.current
            rel = None
            try:
                rr = os.path.realpath(self.cwd)
                if rr == self.root or rr.startswith(self.root + os.sep):
                    rel = "" if rr == self.root else os.path.relpath(rr, self.root)
            except OSError:
                pass
            return {"id": self.id, "project": self.project, "state": self.state, "pid": self.proc.pid if self.proc else None,
                    "cwd": self.cwd, "rel_cwd": rel, "cols": self.cols, "rows": self.rows, "restarts": self.restarts,
                    "created": self.created, "latest_seq": self.log.seq,
                    "current": ({k: cur[k] for k in ("id", "command", "status", "started", "deadline")} if cur else None),
                    "history": list(self.history)[-10:]}


# ------------------------------------------------------------------ jobs (pipe mode: separate stderr)
class Job:
    def __init__(self, daemon, jid, argv, shell_cmd, cwd, env, timeout_ms, want_stdin, project):
        self.d, self.id, self.project = daemon, jid, project
        self.log = EventLog(8 * 1024 * 1024)
        self.lock = threading.RLock()
        self.command = redact(shell_cmd if shell_cmd is not None else " ".join(shlex.quote(a) for a in argv))
        self.state = "RUNNING"
        self.exit_code = None
        self.signal = None
        self.cancelled = self.timed_out = False
        self.sig_stage = 0
        self.sig_t0 = 0
        self.started = time.time()
        self.ended = None
        self.deadline = self.started + timeout_ms / 1000.0 if timeout_ms else None
        self.cwd = cwd
        args = argv if argv is not None else [shutil.which("bash") or "/bin/sh", "-c", shell_cmd]
        try:
            self.proc = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE if want_stdin else subprocess.DEVNULL,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as e:
            raise ApiError("SPAWN_FAILED", "Could not start the process: %s" % e.strerror, 400, "errno=%s" % e.errno)
        self.pid = self.proc.pid
        self.log.append("start", pid=self.pid, command=self.command, cwd=cwd)
        self.readers = [threading.Thread(target=self._pump, args=(self.proc.stdout, "stdout"), daemon=True),
                        threading.Thread(target=self._pump, args=(self.proc.stderr, "stderr"), daemon=True)]
        for t in self.readers:
            t.start()
        threading.Thread(target=self._wait, daemon=True).start()

    def _pump(self, pipe, name):
        dec = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = os.read(pipe.fileno(), 65536) if self._readable(pipe) else b""
            if not chunk:
                break
            t = dec.decode(chunk)
            if t:
                self.log.append("output", stream=name, data=redact(t))
        t = dec.decode(b"", final=True)
        if t:
            self.log.append("output", stream=name, data=redact(t))

    @staticmethod
    def _readable(pipe):
        try:
            select.select([pipe], [], [])
            return True
        except (OSError, ValueError):
            return False

    def _wait(self):
        code = self.proc.wait()
        for t in self.readers:
            t.join(2)
        with self.lock:
            self.signal = -code if code < 0 else None
            self.exit_code = (128 + self.signal) if self.signal else code
            if self.timed_out:
                self.state = "TIMEOUT"
            elif self.cancelled:
                self.state = "CANCELLED"
            else:
                self.state = "SUCCESS" if code == 0 else "FAILED"
            self.ended = time.time()
            self.log.append("end", status=self.state, exit_code=self.exit_code, signal=self.signal,
                            duration_ms=int((self.ended - self.started) * 1000))

    def stdin(self, data, close=False):
        with self.lock:
            if self.state != "RUNNING" or self.proc.stdin is None:
                raise ApiError("NOT_RUNNING", "The job is not accepting input.", 409)
            try:
                if data:
                    self.proc.stdin.write(data)
                    self.proc.stdin.flush()
                if close:
                    self.proc.stdin.close()
            except (BrokenPipeError, OSError):
                raise ApiError("NOT_RUNNING", "The process closed its input.", 409)

    def cancel(self):
        with self.lock:
            if self.state != "RUNNING":
                return {"cancelled": False, "reason": "already %s" % self.state}
            self.cancelled = True
            if not self.sig_stage:
                self.sig_stage, self.sig_t0 = 1, time.time()
                self._signal(signal.SIGINT)
            return {"cancelled": True}

    def _signal(self, sig):
        try:
            os.killpg(self.proc.pid, sig)
        except OSError:
            pass

    def tick(self, now):
        with self.lock:
            if self.state != "RUNNING":
                return
            if self.deadline and now > self.deadline and not self.timed_out:
                self.timed_out = True
                if not self.sig_stage:
                    self.sig_stage, self.sig_t0 = 1, now
                    self._signal(signal.SIGINT)
            if self.sig_stage:
                el = now - self.sig_t0
                if el > 2 and self.sig_stage == 1:
                    self.sig_stage = 2
                    self._signal(signal.SIGTERM)
                elif el > 4 and self.sig_stage == 2:
                    self.sig_stage = 3
                    self._signal(signal.SIGKILL)

    def info(self):
        with self.lock:
            return {"id": self.id, "project": self.project, "command": self.command, "state": self.state, "pid": self.pid,
                    "exit_code": self.exit_code, "signal": self.signal, "started": self.started, "ended": self.ended,
                    "cwd": self.cwd, "latest_seq": self.log.seq}


# ------------------------------------------------------------------ daemon core
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


# ------------------------------------------------------------------ filesystem service
class FS:
    def __init__(self, ws):
        self.ws = ws

    def _entry(self, root, full, name):
        p = os.path.join(full, name)
        try:
            lst = os.lstat(p)
        except OSError:
            return None
        import stat as S
        link = S.S_ISLNK(lst.st_mode)
        outside = False
        typ = "dir" if S.S_ISDIR(lst.st_mode) else "file"
        if link:
            rp = os.path.realpath(p)
            outside = not (rp == root or rp.startswith(root + os.sep))
            typ = "symlink"
            try:
                st = os.stat(p)
                if not outside:
                    typ = "dir" if S.S_ISDIR(st.st_mode) else "file"
            except OSError:
                pass
        return {"name": name, "path": self.ws.relpath(root, os.path.join(full, name)) if not link else self.ws.relpath(root, p if False else os.path.join(full, name)),
                "type": typ, "size": lst.st_size, "mtime_ns": lst.st_mtime_ns, "symlink": link,
                "outside_project": outside, "mode": oct(lst.st_mode & 0o777)}

    def list(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path", ""), must_exist=True)
        if not os.path.isdir(full):
            raise ApiError("NOT_DIRECTORY", "Not a folder.", 400)
        hidden = bool(a.get("include_hidden", True))
        try:
            names = os.listdir(full)
        except OSError as e:
            raise os_error(e, "list")
        out = []
        for n in names:
            if n == ".git" or (not hidden and n.startswith(".")):
                continue
            e = self._entry(root, full, n)
            if e:
                # path of a symlink entry must stay lexical so the UI can show it
                e["path"] = (rel + "/" if rel else "") + n
                out.append(e)
        out.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
        limit = int(a.get("limit", 5000))
        crumbs, acc = [{"name": a.get("project"), "path": ""}], []
        for p in rel.split("/") if rel else []:
            acc.append(p)
            crumbs.append({"name": p, "path": "/".join(acc)})
        return {"path": rel, "breadcrumbs": crumbs, "entries": out[:limit], "total": len(out), "truncated": len(out) > limit}

    def stat(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path", ""))
        try:
            st = os.stat(full)
        except OSError as e:
            if e.errno == 2:
                return {"exists": False, "path": rel}
            raise os_error(e, "stat")
        import stat as S
        return {"exists": True, "path": rel, "type": "dir" if S.S_ISDIR(st.st_mode) else "file", "size": st.st_size,
                "mtime_ns": st.st_mtime_ns, "mode": oct(st.st_mode & 0o777), "writable": os.access(full, os.W_OK)}

    def read(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path"), must_exist=True)
        if os.path.isdir(full):
            raise ApiError("IS_DIRECTORY", "That is a folder.", 400)
        limit = min(int(a.get("limit", MAX_READ_DEFAULT)), MAX_READ_HARD)
        offset = max(0, int(a.get("offset", 0)))
        try:
            st = os.stat(full)
            with open(full, "rb") as f:
                head = f.read(8192)
                if b"\0" in head:
                    return {"path": rel, "binary": True, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "content": None}
                f.seek(offset)
                raw = f.read(limit)
        except OSError as e:
            raise os_error(e, "read")
        if offset and raw[:1] and (raw[0] & 0xC0) == 0x80:      # don't start inside a UTF-8 sequence
            skip = 0
            while skip < len(raw) and (raw[skip] & 0xC0) == 0x80 and skip < 4:
                skip += 1
            raw = raw[skip:]
        truncated = offset + len(raw) < st.st_size
        if truncated:
            while raw and (raw[-1] & 0xC0) == 0x80:      # trim partial trailing multi-byte char
                raw = raw[:-1]
            if raw and raw[-1] >= 0xC0:
                raw = raw[:-1]
        text = raw.decode("utf-8", "replace")
        return {"path": rel, "binary": False, "content": text, "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                "offset": offset, "bytes": len(raw), "truncated": truncated,
                "lossy": "\ufffd" in text, "line_endings": "crlf" if "\r\n" in text else "lf"}

    def write(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path"))
        if not rel:
            raise ApiError("INVALID_PATH", "A file name is required.", 400)
        content = a.get("content")
        if not isinstance(content, str):
            raise ApiError("INVALID_ARGUMENT", "content must be a string.", 400)
        data = content.encode("utf-8")
        if len(data) > MAX_WRITE:
            raise ApiError("FILE_TOO_LARGE", "Content is larger than %d MB." % (MAX_WRITE >> 20), 413)
        exists = os.path.lexists(full)
        if a.get("create_only") and exists:
            raise ApiError("ALREADY_EXISTS", "%s already exists." % rel, 409)
        if exists and os.path.isdir(full):
            raise ApiError("IS_DIRECTORY", "%s is a folder." % rel, 400)
        if exists and a.get("expect_mtime_ns") is not None:
            if os.stat(full).st_mtime_ns != int(a["expect_mtime_ns"]):
                raise ApiError("CONFLICT", "The file changed on disk since you opened it.", 409)
        parent = os.path.dirname(full)
        try:
            os.makedirs(parent, exist_ok=True)
            mode = os.stat(full).st_mode & 0o777 if exists else 0o644
            fd, tmp = tempfile.mkstemp(prefix=".oc-", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
                os.chmod(tmp, mode)
                os.replace(tmp, full)     # atomic; replaces a symlink itself, never follows it
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as e:
            raise os_error(e, "write")
        st = os.stat(full)
        return {"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "created": not exists}

    def mkdir(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path"))
        if not rel:
            raise ApiError("INVALID_PATH", "A folder name is required.", 400)
        try:
            os.makedirs(full, exist_ok=bool(a.get("exist_ok")))
        except OSError as e:
            raise os_error(e, "mkdir")
        return {"path": rel}

    def rename(self, a):
        root, src, srel = self.ws.resolve(a.get("project"), a.get("from"), must_exist=True)
        _, dst, drel = self.ws.resolve(a.get("project"), a.get("to"))
        if not srel or not drel:
            raise ApiError("INVALID_PATH", "Cannot move the project root.", 400)
        if os.path.lexists(dst) and not a.get("overwrite"):
            raise ApiError("ALREADY_EXISTS", "%s already exists." % drel, 409)
        if os.path.isdir(src) and (dst + os.sep).startswith(src + os.sep):
            raise ApiError("INVALID_ARGUMENT", "Cannot move a folder into itself.", 400)
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)
        except OSError as e:
            raise os_error(e, "move")
        return {"from": srel, "to": drel}

    def copy(self, a):
        root, src, srel = self.ws.resolve(a.get("project"), a.get("from"), must_exist=True)
        _, dst, drel = self.ws.resolve(a.get("project"), a.get("to"))
        if not drel:
            raise ApiError("INVALID_PATH", "Invalid destination.", 400)
        if os.path.lexists(dst):
            raise ApiError("ALREADY_EXISTS", "%s already exists." % drel, 409)
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                if (dst + os.sep).startswith(src + os.sep):
                    raise ApiError("INVALID_ARGUMENT", "Cannot copy a folder into itself.", 400)
                shutil.copytree(src, dst, symlinks=True)
            else:
                shutil.copy2(src, dst)
        except OSError as e:
            raise os_error(e, "copy")
        return {"from": srel, "to": drel}

    def delete(self, a):
        root = self.ws.project_dir(a.get("project"))
        parts = self.ws.norm(a.get("path"))
        if not parts:
            raise ApiError("INVALID_PATH", "The project folder itself cannot be deleted here.", 400)
        lexical = os.path.join(os.path.realpath(os.path.join(root, *parts[:-1])), parts[-1])   # delete a symlink itself, not its target
        if not (lexical + os.sep).startswith(root + os.sep):
            raise ApiError("PATH_OUTSIDE_PROJECT", "That path is outside the project folder.", 403)
        if not os.path.lexists(lexical):
            raise ApiError("NOT_FOUND", "Nothing to delete.", 404)
        try:
            if os.path.isdir(lexical) and not os.path.islink(lexical):
                if not a.get("recursive") and os.listdir(lexical):
                    raise ApiError("NOT_EMPTY", "Folder is not empty (pass recursive=true).", 409)
                shutil.rmtree(lexical)
            else:
                os.unlink(lexical)
        except OSError as e:
            raise os_error(e, "delete")
        return {"path": "/".join(parts)}

    def search(self, a):
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path", ""), must_exist=True)
        q = a.get("query") or ""
        if len(q) < 1:
            return {"results": [], "truncated": False}
        use_re = bool(a.get("regex"))
        try:
            rx = re.compile(q if use_re else re.escape(q), 0 if a.get("case_sensitive") else re.I)
        except re.error as e:
            raise ApiError("INVALID_ARGUMENT", "Bad pattern: %s" % e, 400)
        maxr = min(int(a.get("max_results", 100)), 1000)
        results, scanned, skipped = [], 0, 0
        deadline = time.time() + 15
        trunc = False
        for dp, dns, fns in os.walk(full, followlinks=False):
            dns[:] = [d for d in dns if d not in (".git", "node_modules", "__pycache__", ".gradle", "build", ".venv")]
            for fn in sorted(fns):
                p = os.path.join(dp, fn)
                rp = self.ws.relpath(root, p)
                if os.path.islink(p):
                    continue
                if rx.search(fn):
                    results.append({"path": rp, "line": 0, "text": "File name match"})
                try:
                    if os.path.getsize(p) > MAX_READ_DEFAULT:
                        skipped += 1
                        continue
                    with open(p, "rb") as f:
                        raw = f.read()
                except OSError:
                    skipped += 1
                    continue
                if b"\0" in raw[:8192]:
                    continue
                scanned += 1
                for i, line in enumerate(raw.decode("utf-8", "replace").split("\n"), 1):
                    if rx.search(line):
                        t = line.strip()
                        results.append({"path": rp, "line": i, "text": t[:200]})
                        if len(results) >= maxr:
                            trunc = True
                            break
                if trunc or time.time() > deadline:
                    trunc = True
                    break
            if trunc:
                break
        return {"results": results, "truncated": trunc, "files_scanned": scanned, "skipped": skipped}

    def projects(self):
        out = []
        seen = set()
        for n in sorted(os.listdir(self.ws.root)):
            p = os.path.join(self.ws.root, n)
            if n.startswith(".") or n in self.ws._external_projects or not os.path.isdir(p) or not NAME_RE.match(n):
                continue
            seen.add(n)
            out.append({"id": n, "name": n, "path": os.path.realpath(p), "updated": int(os.stat(p).st_mtime * 1000), "git": os.path.isdir(os.path.join(p, ".git"))})
        for n, p in list(self.ws._external_projects.items()):
            if os.path.isdir(p):
                seen.add(n)
                out.append({"id": n, "name": n, "path": os.path.realpath(p), "updated": int(os.stat(p).st_mtime * 1000), "git": os.path.isdir(os.path.join(p, ".git"))})
        return out

    def create_project(self, a):
        name = (a.get("name") or "").strip()
        if not NAME_RE.match(name) or name.startswith("."):
            raise ApiError("INVALID_ARGUMENT", "Use letters, numbers, spaces, dots, dashes (max 64).", 400)
        parent_arg = a.get("parent")
        parent = self.ws._validate_external_parent(parent_arg) if parent_arg else self.ws.root
        p = os.path.join(parent, name)
        if name in self.ws._external_projects or os.path.exists(p) or os.path.lexists(os.path.join(self.ws.root, name)):
            raise ApiError("ALREADY_EXISTS", "A project named \"%s\" already exists or that folder name is taken." % name, 409)
        try:
            os.makedirs(p)
            with open(os.path.join(p, "README.md"), "w", encoding="utf-8") as f:
                f.write("# %s\n" % name)
            if parent != self.ws.root:
                self.ws._external_projects[name] = os.path.realpath(p)
                self.ws._save_external_projects()
        except OSError as e:
            raise os_error(e, "create project")
        return {"id": name, "name": name, "path": os.path.realpath(p), "updated": int(time.time() * 1000)}


    def rename_project(self, a):
        old = (a.get("id") or "").strip()
        new = (a.get("name") or "").strip()
        if not NAME_RE.match(old) or old.startswith(".") or not NAME_RE.match(new) or new.startswith("."):
            raise ApiError("INVALID_ARGUMENT", "Invalid project name.", 400)
        lexical_src = os.path.join(self.ws.root, old)
        if os.path.islink(lexical_src):
            raise ApiError("INVALID_PATH", "A symlinked project cannot be renamed safely.", 400)
        src = self.ws.project_dir(old)
        external = old in self.ws._external_projects
        dst = os.path.join(os.path.dirname(src), new) if external else os.path.join(self.ws.root, new)
        if os.path.lexists(os.path.join(self.ws.root, new)) or new in self.ws._external_projects:
            if new != old:
                raise ApiError("ALREADY_EXISTS", "A project named \"%s\" already exists." % new, 409)
        if os.path.realpath(src) == os.path.realpath(dst):
            return {"id": new, "name": new, "updated": int(os.stat(src).st_mtime * 1000)}
        if os.path.lexists(dst):
            raise ApiError("ALREADY_EXISTS", "A project folder named \"%s\" already exists." % new, 409)
        try:
            os.replace(src, dst)
            if external:
                del self.ws._external_projects[old]
                self.ws._external_projects[new] = os.path.realpath(dst)
                self.ws._save_external_projects()
        except OSError as e:
            raise os_error(e, "rename project")
        return {"id": new, "name": new, "path": os.path.realpath(dst), "updated": int(os.stat(dst).st_mtime * 1000)}

    def delete_project(self, a):
        name = (a.get("id") or "").strip()
        path = self.ws.project_dir(name)
        external = name in self.ws._external_projects
        # External projects are removed only at the exact directory registered at creation.
        if os.path.islink(os.path.join(self.ws.root, name)) or os.path.realpath(path) == self.ws.root:
            raise ApiError("INVALID_PATH", "This project cannot be deleted safely.", 400)
        try:
            shutil.rmtree(path)
            if external:
                del self.ws._external_projects[name]
                self.ws._save_external_projects()
        except OSError as e:
            raise os_error(e, "delete project")
        return {"id": name, "deleted": True}


# ------------------------------------------------------------------ health
def _run(argv, timeout=8):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 126, "", str(e)


def health(d, network=True):
    checks = []

    def add(key, name, status, detail, raw=None):
        checks.append({"key": key, "name": name, "status": status, "detail": detail, "raw": raw})

    termux = "com.termux" in os.environ.get("PREFIX", "") or "TERMUX_VERSION" in os.environ
    add("termux", "Termux", "ok" if termux else "warning",
        "Termux %s" % os.environ.get("TERMUX_VERSION", "(version unknown)") if termux else "Not running inside Termux (PREFIX/TERMUX_VERSION unset)")
    android = os.path.exists("/system/build.prop") or "ANDROID_ROOT" in os.environ
    ver = ""
    if android:
        rc, out, _ = _run(["getprop", "ro.build.version.release"], 3)
        ver = out if rc == 0 else ""
    add("os", "Android", "ok" if android else "warning", ("Android " + ver) if android else "Not Android (%s)" % sys.platform)
    import platform
    m = platform.machine()
    add("arch", "Architecture", "ok" if m in ("aarch64", "arm64") else "warning", m)
    for key, name, argv in (("node", "Node", ["node", "--version"]), ("npm", "npm", ["npm", "--version"]),
                            ("python", "Python", [sys.executable, "--version"]), ("git", "Git", ["git", "--version"]),
                            ("shell", "Shell (bash)", ["bash", "--version"])):
        rc, out, err = _run(argv, 10)
        if rc == 0:
            add(key, name, "ok", (out or err).splitlines()[0])
        else:
            add(key, name, "failed", "%s is not usable" % name, "exit %s: %s" % (rc, err or "not found"))
    # real PTY probe: allocate a pty, spawn bash on it, read output back
    try:
        t0 = time.time()
        m_, s_ = os.openpty()
        p = subprocess.Popen(["bash", "-c", "echo OC_PTY_OK; test -t 0 && echo TTY_YES"], stdin=s_, stdout=s_, stderr=s_, start_new_session=True)
        os.close(s_)
        out = b""
        while time.time() - t0 < 5:
            r, _, _ = select.select([m_], [], [], 0.3)
            if r:
                try:
                    c = os.read(m_, 4096)
                except OSError:
                    break
                if not c:
                    break
                out += c
            elif p.poll() is not None:
                break
        p.wait(2)
        os.close(m_)
        ok = b"OC_PTY_OK" in out and b"TTY_YES" in out
        add("pty", "PTY", "ok" if ok else "failed", "PTY allocated, shell saw a tty" if ok else "PTY probe failed", None if ok else repr(out[:200]))
    except Exception as e:
        add("pty", "PTY", "failed", "Could not allocate a PTY", repr(e))
    try:
        probe = os.path.join(d.ws.root, ".oc-probe-%s" % uuid.uuid4().hex[:6])
        with open(probe, "w") as f:
            f.write("x")
        os.unlink(probe)
        add("workspace", "Workspace", "ok", d.ws.root)
    except OSError as e:
        add("workspace", "Workspace", "failed", "Workspace is not writable", str(e))
    sv = os.statvfs(d.ws.root)
    free = sv.f_bavail * sv.f_frsize // (1024 * 1024)
    add("storage", "Storage", "failed" if free < 200 else "ok", "%d MB free" % free, "ENOSPC risk: only %d MB free" % free if free < 200 else None)
    rc, out, err = _run(["bash", "-c", "echo OC_EXEC_OK"], 5)
    ok = rc == 0 and out == "OC_EXEC_OK"
    add("process", "Process execution", "ok" if ok else "failed",
        ("Spawned a real process; %d session(s), %d job(s) tracked" % (len(d.sessions), len(d.jobs))) if ok else "Could not run a process",
        None if ok else "exit %s: %s" % (rc, err))
    gok = False
    try:
        import tempfile as _t
        with _t.TemporaryDirectory(dir=d.ws.root, prefix=".oc-gitprobe-") as td:
            r1 = _run(["git", "init", "-q", td], 8)
            gok = r1[0] == 0 and os.path.isdir(os.path.join(td, ".git"))
    except Exception:
        gok = False
    add("git_ops", "Git repository support", "ok" if gok else "failed", "git init works in the workspace" if gok else "git cannot create a repository in the workspace")
    if network:
        try:
            s = socket.create_connection(("1.1.1.1", 443), 3)
            s.close()
            add("network", "Network", "ok", "TCP 1.1.1.1:443 reachable")
        except OSError as e:
            add("network", "Network", "failed", "No outbound network", str(e))
    st = "ok"
    for c in checks:
        if c["status"] == "failed":
            st = "failed"
            break
        if c["status"] == "warning":
            st = "warning"
    return {"status": st, "checks": checks, "daemon": VERSION}


# ------------------------------------------------------------------ HTTP layer
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
        return {"daemon": VERSION, "customProjectParents": True, "strictParent": True}

    @route("GET", r"/v1/projects")
    def pl(h, m, q, a):
        return fs.projects()

    @route("POST", r"/v1/projects")
    def pc(h, m, q, a):
        if a.get("require_parent") is True and not a.get("parent"):
            raise ApiError("INVALID_PATH", "A custom project parent was required but no parent path was supplied. No project was created.", 400)
        return fs.create_project(a)

    @route("POST", r"/v1/projects/rename")
    def pr(h, m, q, a):
        return fs.rename_project(a)

    @route("POST", r"/v1/projects/delete")
    def pd(h, m, q, a):
        return fs.delete_project(a)

    for name in ("list", "stat", "read", "write", "mkdir", "rename", "copy", "delete", "search"):
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


def load_token(args):
    tok = os.environ.pop("OC_DAEMON_TOKEN", None)
    if args.token_stdin:
        tok = sys.stdin.readline().strip()
    if not tok:
        tf = os.path.expanduser(args.token_file)
        if os.path.exists(tf):
            if os.stat(tf).st_mode & 0o077:
                os.chmod(tf, 0o600)
            tok = open(tf).read().strip()
        else:
            os.makedirs(os.path.dirname(tf), exist_ok=True)
            tok = secrets.token_urlsafe(32)
            fd = os.open(tf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(tok + "\n")
    if len(tok) < 24:
        sys.exit("token must be at least 24 characters")
    return tok


def main(argv=None):
    ap = argparse.ArgumentParser(description="OpenCode SI daemon")
    ap.add_argument("--workspace", default="~/OpenCodeProjects")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token-file", default="~/.opencode-si/daemon.token")
    ap.add_argument("--token-stdin", action="store_true")
    ap.add_argument("--io-timeout", type=float, default=30.0)
    ap.add_argument("--info-file", default="~/.opencode-si/daemon.json")
    args = ap.parse_args(argv)
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("refusing to bind to a non-loopback address (%s)" % args.host)
    d = Daemon(args.workspace, load_token(args))
    d.io_timeout = args.io_timeout
    fs = FS(d.ws)
    srv = ThreadingHTTPServer((args.host if args.host != "localhost" else "127.0.0.1", args.port), None)
    srv.daemon_threads = True
    d.port = srv.server_address[1]
    srv.RequestHandlerClass = make_handler(d, fs)
    info = os.path.expanduser(args.info_file)
    os.makedirs(os.path.dirname(info), exist_ok=True)
    fd = os.open(info, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"port": d.port, "pid": os.getpid(), "version": VERSION, "workspace": d.ws.root, "started": d.started}, f)
    print("ocd %s listening on %s:%d workspace=%s" % (VERSION, args.host, d.port, d.ws.root), flush=True)

    def stop(*_):
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        srv.serve_forever()
    finally:
        d.shutdown()
        try:
            os.unlink(info)
        except OSError:
            pass


if __name__ == "__main__":
    main()
