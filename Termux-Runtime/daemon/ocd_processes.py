"""PTY session and pipe-job lifecycle primitives."""
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
import struct
import subprocess
import tempfile
import termios
import threading
import time
from ocd_errors import ApiError
from ocd_events import EventLog
from ocd_policy import redact
from ocd_workspace import Workspace

HDR = b"\x1b]777;OC;"

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


