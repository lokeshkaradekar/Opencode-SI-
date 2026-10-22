"""Integration tests: spawn the REAL daemon and drive REAL processes. No mocks.
Run:  python3 -m unittest -v daemon/tests/test_daemon.py   (from repo root)
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OCD = os.path.join(HERE, "..", "ocd.py")


import re
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def strip_ansi(s):
    return ANSI.sub("", s)


def terminate_and_reap(proc, term_timeout=10, kill_timeout=5):
    """Stop a child without leaving an unreaped process if graceful shutdown fails."""
    if proc is None:
        return
    if proc.poll() is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=term_timeout)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            # wait() after kill is essential: kill alone leaves a zombie until reaped.
            proc.wait(timeout=kill_timeout)
    else:
        # poll() detects the exit but wait() performs/re-confirms reaping.
        proc.wait(timeout=kill_timeout)


def wait_for_info_file(proc, info_path, timeout=10, stdout_path=None, stderr_path=None):
    """Wait for the daemon's atomically closed info file without blocking on a pipe read."""
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        if os.path.isfile(info_path):
            try:
                with open(info_path, encoding="utf-8") as stream:
                    info = json.load(stream)
                if isinstance(info, dict) and isinstance(info.get("port"), int):
                    return info
                last_error = "info file did not contain a numeric port"
            except (OSError, ValueError) as exc:
                # The file may be visible between open/truncate and the completed write.
                last_error = str(exc)
        if proc.poll() is not None:
            break
        time.sleep(0.05)

    def contents(path):
        if not path or not os.path.isfile(path):
            return "(empty)"
        try:
            with open(path, encoding="utf-8", errors="replace") as stream:
                return stream.read()[-4000:] or "(empty)"
        except OSError as exc:
            return "(unreadable: %s)" % exc

    raise RuntimeError(
        "daemon failed to publish startup info within %ss (exit=%r, last_info_error=%r); "
        "stdout=%r; stderr=%r" %
        (timeout, proc.poll(), last_error, contents(stdout_path), contents(stderr_path))
    )


class Client:
    def __init__(self, port, token):
        self.base = "http://127.0.0.1:%d" % port
        self.token = token

    def raw(self, method, path, body=None, headers=None, token=True):
        h = {"Content-Type": "application/json"}
        if token:
            h["Authorization"] = "Bearer " + self.token
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def call(self, method, path, body=None):
        st, r = self.raw(method, path, body)
        if not r["success"]:
            raise AssertionError("%s %s -> %s %s" % (method, path, st, r["error"]))
        return r["data"]

    def err(self, method, path, body=None):
        st, r = self.raw(method, path, body)
        assert not r["success"], "expected error, got %r" % (r,)
        return st, r["error"]


class Term:
    """Thin terminal controller over the daemon API (what LocalTermuxBackend does on Android)."""

    def __init__(self, c, project, cwd="", **kw):
        self.c = c
        self.s = c.call("POST", "/v1/sessions", dict(project=project, cwd=cwd, **kw))
        self.sid = self.s["id"]
        self.seq = 0
        self.events = []

    def poll(self, wait_ms=0):
        r = self.c.call("GET", "/v1/sessions/%s/events?since=%d&wait_ms=%d" % (self.sid, self.seq, wait_ms))
        self.seq = r["next"]
        self.events += r["events"]
        return r["events"]

    def run(self, cmd, timeout_ms=0, confirmed=False, wait=30):
        """Execute and wait for command_end. Returns (end_event, output_text)."""
        start_seq = self.seq
        r = self.c.call("POST", "/v1/sessions/%s/exec" % self.sid, {"command": cmd, "timeout_ms": timeout_ms, "confirmed": confirmed})
        return self.wait_end(r["id"], wait)

    def start(self, cmd, **kw):
        return self.c.call("POST", "/v1/sessions/%s/exec" % self.sid, dict(command=cmd, **kw))

    def wait_end(self, cmd_id, wait=30):
        deadline = time.time() + wait
        out, end = [], None
        while time.time() < deadline and not end:
            for e in self.poll(1000):
                if e["type"] == "output" and e.get("cmd") == cmd_id:
                    out.append(e["data"])
                if e["type"] == "command_end" and e["cmd"] == cmd_id:
                    end = e
        if not end:
            raise AssertionError("command %s did not end within %ss; output=%r" % (cmd_id, wait, "".join(out)))
        return end, "".join(out)

    def info(self):
        return self.c.call("GET", "/v1/sessions/" + self.sid)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="oc-test-")
        cls.ws = os.path.join(cls.tmp, "OpenCodeProjects")
        cls.info_path = os.path.join(cls.tmp, "info.json")
        cls.stdout_path = os.path.join(cls.tmp, "daemon.stdout.log")
        cls.stderr_path = os.path.join(cls.tmp, "daemon.stderr.log")
        cls._stdout_file = None
        cls._stderr_file = None
        cls.proc = None
        try:
            os.makedirs(cls.ws)
            cls.token = "t" * 40
            # Files instead of unread PIPEs prevent an unconsumed output pipe from blocking the daemon.
            cls._stdout_file = open(cls.stdout_path, "w", encoding="utf-8")
            cls._stderr_file = open(cls.stderr_path, "w", encoding="utf-8")
            cls.proc = subprocess.Popen(
                [sys.executable, OCD, "--workspace", cls.ws, "--port", "0",
                 "--token-file", os.path.join(cls.tmp, "tok"), "--info-file", cls.info_path],
                env=dict(os.environ, OC_DAEMON_TOKEN=cls.token),
                stdout=cls._stdout_file, stderr=cls._stderr_file, text=True,
            )
            info = wait_for_info_file(cls.proc, cls.info_path, timeout=10,
                                      stdout_path=cls.stdout_path, stderr_path=cls.stderr_path)
            cls.port = info["port"]
            cls.c = Client(cls.port, cls.token)
            cls.c.call("POST", "/v1/projects", {"name": "Axiom Engine"})
            root = os.path.join(cls.ws, "Axiom Engine")
            os.makedirs(os.path.join(root, "src"))
            os.makedirs(os.path.join(root, "test"))
            with open(os.path.join(root, "package.json"), "w", encoding="utf-8") as stream:
                json.dump({"name": "axiom-engine", "version": "0.1.0",
                           "scripts": {"test": "node test/engine.test.js", "dev": "node src/server.js"}}, stream)
            with open(os.path.join(root, "src", "server.js"), "w", encoding="utf-8") as stream:
                stream.write("const http=require('http');\nconst s=http.createServer((q,r)=>r.end('DEV_OK'));\n"
                             "s.listen(0,'127.0.0.1',()=>console.log('DEV_LISTENING '+s.address().port));\n"
                             "process.on('SIGINT',()=>{console.log('DEV_SIGINT');process.exit(0)});\n")
            with open(os.path.join(root, "test", "engine.test.js"), "w", encoding="utf-8") as stream:
                stream.write("console.log('engine: ok');\n")
            cls.root = root
            subprocess.run("git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init",
                           shell=True, cwd=root, check=True, timeout=15)
        except BaseException:
            try:
                terminate_and_reap(cls.proc, term_timeout=2, kill_timeout=3)
            finally:
                cls._close_process_logs()
                shutil.rmtree(cls.tmp, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            terminate_and_reap(getattr(cls, "proc", None))
        finally:
            cls._close_process_logs()
            shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    @classmethod
    def _close_process_logs(cls):
        for attr in ("_stdout_file", "_stderr_file"):
            stream = getattr(cls, attr, None)
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
                setattr(cls, attr, None)


class TestProcessFixture(unittest.TestCase):
    def test_teardown_kills_and_reaps_child_that_ignores_sigterm(self):
        proc = subprocess.Popen([
            sys.executable, "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        ])
        try:
            time.sleep(0.1)
            terminate_and_reap(proc, term_timeout=0.1, kill_timeout=2)
            self.assertIsNotNone(proc.returncode, "terminated child must be reaped, not left as a zombie")
            self.assertEqual(proc.wait(timeout=0.1), proc.returncode)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)

    def test_startup_wait_fails_fast_when_child_exits_without_info(self):
        with tempfile.TemporaryDirectory(prefix="oc-info-test-") as tmp:
            proc = subprocess.Popen([sys.executable, "-c", "pass"])
            try:
                started = time.monotonic()
                with self.assertRaisesRegex(RuntimeError, "failed to publish startup info"):
                    wait_for_info_file(proc, os.path.join(tmp, "missing.json"), timeout=2)
                self.assertLess(time.monotonic() - started, 1.5)
            finally:
                terminate_and_reap(proc, term_timeout=0.1, kill_timeout=2)


class TestPtyMilestone(Base):
    """The exact operations requested for the PTY milestone."""

    def test_01_exact_sequence(self):
        t = Term(self.c, "Axiom Engine")
        end, out = t.run("pwd")
        self.assertEqual((end["status"], end["exit_code"]), ("SUCCESS", 0))
        self.assertEqual(out.strip(), self.root)
        end, out = t.run("cd src")
        self.assertEqual(end["status"], "SUCCESS")
        end, out = t.run("pwd")
        self.assertEqual(out.strip(), os.path.join(self.root, "src"))          # cd persisted
        self.assertEqual(t.info()["rel_cwd"], "src")
        end, out = t.run('echo "OPEN_CODE_REAL_TEST_1610" > REAL_TEST.txt')
        self.assertEqual(end["status"], "SUCCESS")
        self.assertTrue(os.path.exists(os.path.join(self.root, "src", "REAL_TEST.txt")))   # on the real disk
        end, out = t.run("cat REAL_TEST.txt")
        self.assertEqual(out.strip(), "OPEN_CODE_REAL_TEST_1610")
        end, out = t.run("node --version")
        self.assertEqual(out.strip(), subprocess.check_output(["node", "--version"], text=True).strip())
        end, out = t.run("npm --version")
        self.assertEqual(strip_ansi(out).strip(), subprocess.check_output(["npm", "--version"], text=True).strip())
        end, out = t.run("git status")
        self.assertEqual(end["exit_code"], 0)
        out = strip_ansi(out)
        self.assertIn("On branch", out)
        self.assertIn("REAL_TEST.txt", out)             # git sees the file we just created
        self.assertNotIn("\x1b]777", out)               # markers never leak into output

    def test_02_exit_codes(self):
        t = Term(self.c, "Axiom Engine")
        end, _ = t.run("true")
        self.assertEqual((end["status"], end["exit_code"]), ("SUCCESS", 0))
        end, _ = t.run("exit_code_probe() { return 3; }; exit_code_probe")
        self.assertEqual((end["status"], end["exit_code"]), ("FAILED", 3))
        end, out = t.run("ls /definitely/not/here")
        self.assertEqual(end["status"], "FAILED")
        self.assertNotEqual(end["exit_code"], 0)
        self.assertIn("No such file", out)
        end, out = t.run("echo still-alive")             # shell survives failures
        self.assertEqual(out.strip(), "still-alive")

    def test_03_streaming(self):
        t = Term(self.c, "Axiom Engine")
        t.start("for i in 1 2 3; do echo tick$i; sleep 0.7; done")
        seen = []                                         # (wall time, text) as events arrive
        t0 = time.time()
        while time.time() - t0 < 15:
            for e in t.poll(1000):
                if e["type"] == "output":
                    seen.append((time.time() - t0, e["data"]))
                if e["type"] == "command_end":
                    break
            else:
                continue
            break
        ticks = [(ts, d) for ts, d in seen if "tick" in d]
        self.assertGreaterEqual(len(ticks), 3)
        self.assertGreater(ticks[-1][0] - ticks[0][0], 1.0, "output arrived in one lump, not streamed: %r" % ticks)

    def test_04_stdin(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start('read -p "name? " x; echo "hello:$x"; read y; echo "second:$y"')
        time.sleep(0.5)
        self.c.call("POST", "/v1/sessions/%s/stdin" % t.sid, {"data": "vittal\n"})
        time.sleep(0.3)
        self.c.call("POST", "/v1/sessions/%s/stdin" % t.sid, {"data": "again\n"})
        end, out = t.wait_end(r["id"])
        self.assertEqual(end["status"], "SUCCESS")
        self.assertIn("hello:vittal", out)
        self.assertIn("second:again", out)
        # a real program reading stdin
        r = t.start("node -e \"process.stdin.on('data',d=>{console.log('NODE_GOT:'+d.toString().trim());process.exit(0)})\"")
        time.sleep(0.8)
        self.c.call("POST", "/v1/sessions/%s/stdin" % t.sid, {"data": "ping\n"})
        end, out = t.wait_end(r["id"])
        self.assertIn("NODE_GOT:ping", out)

    def test_05_ctrl_c_keystroke(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start("sleep 60")
        time.sleep(0.6)
        self.assertEqual(t.info()["state"], "running")
        t0 = time.time()
        self.c.call("POST", "/v1/sessions/%s/interrupt" % t.sid)       # literal Ctrl+C
        end, _ = t.wait_end(r["id"], 10)
        self.assertLess(time.time() - t0, 3)
        self.assertEqual(end["status"], "CANCELLED")
        self.assertEqual(end["exit_code"], 130)
        end, out = t.run("echo after-ctrl-c")                           # shell itself survived
        self.assertEqual(out.strip(), "after-ctrl-c")

    def test_06_cancel(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start("sleep 59.7131")                      # unique duration so we can find exactly our process
        time.sleep(0.5)
        pids = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
        ours = [p for p in pids if "59.7131" in open("/proc/%s/cmdline" % p).read()]
        self.assertEqual(len(ours), 1, "expected exactly one running sleep, got %r" % ours)
        self.assertTrue(self.c.call("POST", "/v1/sessions/%s/cancel" % t.sid)["cancelled"])
        end, _ = t.wait_end(r["id"], 10)
        self.assertEqual(end["status"], "CANCELLED")
        self.assertFalse(os.path.exists("/proc/%s" % ours[0]) and "sleep" in open("/proc/%s/cmdline" % ours[0]).read(),
                         "cancelled process is still alive")

    def test_07_timeout(self):
        t = Term(self.c, "Axiom Engine")
        t0 = time.time()
        end, _ = t.run("sleep 60", timeout_ms=1200, wait=15)
        self.assertEqual(end["status"], "TIMEOUT")
        self.assertLess(time.time() - t0, 6)
        end, out = t.run("echo ok-after-timeout")
        self.assertEqual(out.strip(), "ok-after-timeout")

    def test_08_timeout_stubborn_process(self):
        """A process that ignores SIGINT/SIGTERM must still be killed (escalation to SIGKILL)."""
        t = Term(self.c, "Axiom Engine")
        end, _ = t.run("node -e \"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"", timeout_ms=800, wait=20)
        self.assertEqual(end["status"], "TIMEOUT")
        end, out = t.run("echo recovered")
        self.assertEqual(out.strip(), "recovered")

    def test_09_long_running_npm_run_dev(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start("npm run dev")
        port = None
        t0 = time.time()
        buf = ""
        while time.time() - t0 < 20 and port is None:
            for e in t.poll(1000):
                if e["type"] == "output":
                    buf += e["data"]
            import re
            m = re.search(r"DEV_LISTENING (\d+)", buf)
            port = int(m.group(1)) if m else None
        self.assertIsNotNone(port, "dev server never started: %r" % buf)
        time.sleep(2.0)                                                 # still RUNNING, not treated as one-shot
        self.assertEqual(t.info()["state"], "running")
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=5) as resp:
            self.assertEqual(resp.read(), b"DEV_OK")                   # genuinely serving
        self.c.call("POST", "/v1/sessions/%s/interrupt" % t.sid)
        end, out = t.wait_end(r["id"], 15)
        self.assertIn(end["status"], ("CANCELLED", "SUCCESS"))
        time.sleep(0.5)
        with self.assertRaises(Exception):
            urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=2)   # server is gone

    def test_10_npm_test_real(self):
        t = Term(self.c, "Axiom Engine")
        end, out = t.run("npm test", wait=60)
        self.assertEqual((end["status"], end["exit_code"]), ("SUCCESS", 0))
        self.assertIn("engine: ok", out)

    def test_11_busy_and_multiline(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start("sleep 3")
        st, err = self.c.err("POST", "/v1/sessions/%s/exec" % t.sid, {"command": "echo x"})
        self.assertEqual((st, err["code"]), (409, "BUSY"))
        t.wait_end(r["id"], 10)
        end, out = t.run("a=1\nb=2\nif [ $((a+b)) -eq 3 ]; then\n  echo sum-ok\nfi")
        self.assertEqual(out.strip(), "sum-ok")
        end, out = t.run("echo 'unterminated")       # syntax error must not hang the session
        self.assertEqual(end["status"], "FAILED")
        end, out = t.run("echo fine")
        self.assertEqual(out.strip(), "fine")

    def test_12_env_persists_and_isolated(self):
        t = Term(self.c, "Axiom Engine", env={"MY_VAR": "from-api"})
        t.run("export OC_TEST_X=persisted; cd test")
        end, out = t.run("echo $OC_TEST_X $MY_VAR; pwd")
        self.assertIn("persisted from-api", out)
        self.assertTrue(out.strip().endswith("/test"))
        end, out = t.run("env | grep -c OC_DAEMON_TOKEN || true")     # daemon token never reaches children
        self.assertEqual(out.strip(), "0")
        t2 = Term(self.c, "Axiom Engine")
        end, out = t2.run("echo [$OC_TEST_X]; pwd")                   # sessions are independent
        self.assertIn("[]", out)

    def test_13_crash_recovery(self):
        t = Term(self.c, "Axiom Engine")
        t.run("cd src")
        pid = t.info()["pid"]
        os.kill(pid, signal.SIGKILL)                                   # kill the shell out from under it
        deadline = time.time() + 10
        while time.time() < deadline and t.info()["state"] != "exited":
            time.sleep(0.2)
        self.assertEqual(t.info()["state"], "exited")
        end, out = t.run("pwd")                                        # next exec auto-recovers
        self.assertEqual(end["status"], "SUCCESS")
        self.assertEqual(t.info()["restarts"], 1)
        self.assertNotEqual(t.info()["pid"], pid)
        self.assertTrue(out.strip().endswith("/src"), "cwd not restored: %r" % out)

    def test_14_command_that_kills_shell(self):
        t = Term(self.c, "Axiom Engine")
        r = t.start("exit 7")
        end, _ = t.wait_end(r["id"], 10)
        self.assertEqual(end["status"], "FAILED")
        self.assertEqual(end["exit_code"], 7)
        self.assertTrue(end["shell_exited"])
        end, out = t.run("echo reborn")
        self.assertEqual(out.strip(), "reborn")

    def test_15_resize_and_tty(self):
        t = Term(self.c, "Axiom Engine", cols=100, rows=30)
        end, out = t.run("stty size; test -t 0 && echo IS_TTY")
        self.assertIn("30 100", out)
        self.assertIn("IS_TTY", out)
        self.c.call("POST", "/v1/sessions/%s/resize" % t.sid, {"cols": 120, "rows": 40})
        end, out = t.run("stty size")
        self.assertIn("40 120", out)

    def test_16_large_output_and_unicode(self):
        t = Term(self.c, "Axiom Engine")
        end, out = t.run("seq 1 20000 | tail -n 3; echo héllo→世界")
        self.assertIn("20000", out)
        self.assertIn("héllo→世界", out)
        end, out = t.run("head -c 300000 /dev/zero | tr '\\0' 'a' | wc -c")
        self.assertEqual(out.strip(), "300000")


class TestPolicyAndAuth(Base):
    def test_auth_required(self):
        st, r = self.c.raw("GET", "/v1/ping", token=False)
        self.assertEqual((st, r["error"]["code"]), (401, "UNAUTHORIZED"))
        st, r = self.c.raw("GET", "/v1/ping", headers={"Authorization": "Bearer wrong"}, token=False)
        self.assertEqual(st, 401)

    def test_origin_and_host_rejected(self):
        st, r = self.c.raw("GET", "/v1/ping", headers={"Origin": "https://evil.example"})
        self.assertEqual((st, r["error"]["code"]), (403, "FORBIDDEN_ORIGIN"))
        st, r = self.c.raw("GET", "/v1/ping", headers={"Host": "evil.example"})
        self.assertEqual((st, r["error"]["code"]), (403, "BAD_HOST"))

    def test_binds_loopback_only(self):
        out = subprocess.run([sys.executable, OCD, "--host", "0.0.0.0", "--workspace", self.ws, "--port", "0"],
                             capture_output=True, text=True, timeout=10)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("non-loopback", out.stderr)
        ss = subprocess.run("ss -ltnp 2>/dev/null | grep ':%d '" % self.port, shell=True, capture_output=True, text=True).stdout
        if ss:
            self.assertIn("127.0.0.1:%d" % self.port, ss)
            self.assertNotIn("0.0.0.0:%d" % self.port, ss)

    def test_token_file_mode(self):
        token_path = os.path.join(self.tmp, "gen.tok")
        info_path = os.path.join(self.tmp, "gen.json")
        stdout_path = os.path.join(self.tmp, "token-daemon.stdout.log")
        stderr_path = os.path.join(self.tmp, "token-daemon.stderr.log")
        with open(stdout_path, "w", encoding="utf-8") as stdout, open(stderr_path, "w", encoding="utf-8") as stderr:
            p = subprocess.Popen([sys.executable, OCD, "--port", "0", "--workspace", self.ws,
                                  "--token-file", token_path, "--info-file", info_path],
                                 stdout=stdout, stderr=stderr, text=True)
            try:
                wait_for_info_file(p, info_path, timeout=10, stdout_path=stdout_path, stderr_path=stderr_path)
                st = os.stat(token_path)
                self.assertEqual(st.st_mode & 0o777, 0o600)
                with open(token_path, encoding="utf-8") as stream:
                    self.assertGreaterEqual(len(stream.read().strip()), 32)
            finally:
                terminate_and_reap(p)

    def test_dangerous_commands_need_confirmation(self):
        t = Term(self.c, "Axiom Engine")
        for cmd in ("rm -rf build", "git reset --hard HEAD~1", "git clean -fd", "git push --force origin main", "git push -f", "chmod -R 777 .", "git branch -D x"):
            st, err = self.c.err("POST", "/v1/sessions/%s/exec" % t.sid, {"command": cmd})
            self.assertEqual((st, err["code"]), (409, "CONFIRMATION_REQUIRED"), cmd)
            self.assertTrue(err["details"])
        # not blocked: useful everyday commands
        for cmd in ("git status", "git diff", "git push origin main --dry-run", "git clean -n", "npm install", "ls -la", "git branch -a", "git checkout -b feature"):
            t.run(cmd) if cmd in ("ls -la", "git status") else None
            from importlib import import_module
        sys.path.insert(0, os.path.join(HERE, ".."))
        ocd = import_module("ocd")
        for cmd in ("git status", "git diff", "git log --oneline", "npm install", "npm test", "node app.js", "python app.py", "git checkout -b feature", "git branch -a", "git clean -n", "git add -A", "git commit -m x", "git pull", "git push origin main", "echo hi > a.txt", "mkdir -p a/b", "cp a b", "mv a b", "find . -name x", "grep -r foo ."):
            self.assertEqual(ocd.Policy.assess(cmd)["level"], "ok", cmd)

    def test_confirmed_runs_and_deletes_for_real(self):
        t = Term(self.c, "Axiom Engine")
        t.run("mkdir -p scratch_dir && touch scratch_dir/a.txt")
        self.assertTrue(os.path.exists(os.path.join(self.root, "scratch_dir", "a.txt")))
        end, _ = t.run("rm -rf scratch_dir", confirmed=True)
        self.assertEqual(end["status"], "SUCCESS")
        self.assertFalse(os.path.exists(os.path.join(self.root, "scratch_dir")))

    def test_catastrophic_denied_even_if_confirmed(self):
        t = Term(self.c, "Axiom Engine")
        for cmd in ("rm -rf /", "rm -rf ~", "rm -rf /*", "mkfs.ext4 /dev/sda1", ":(){ :|:& };:"):
            st, err = self.c.err("POST", "/v1/sessions/%s/exec" % t.sid, {"command": cmd, "confirmed": True})
            self.assertEqual((st, err["code"]), (403, "COMMAND_DENIED"), cmd)

    def test_secrets_redacted_in_output_and_history(self):
        t = Term(self.c, "Axiom Engine")
        end, out = t.run("echo 'remote https://user:hunter2secret@github.com/x/y.git key sk-abcdefghijklmnopqrstuvwxyz123456'")
        self.assertNotIn("hunter2secret", out)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", out)
        ev = [e for e in t.events if e["type"] == "command_start"][-1]
        self.assertNotIn("hunter2secret", ev["command"])

    def test_bad_inputs(self):
        for body in ({"project": "../etc"}, {"project": "nope"}, {"project": "Axiom Engine", "cwd": "../.."}, {"project": ".hidden"}):
            st, err = self.c.err("POST", "/v1/sessions", body)
            self.assertIn(st, (400, 403, 404), body)
        st, err = self.c.err("POST", "/v1/sessions/nosuch/exec", {"command": "ls"})
        self.assertEqual(st, 404)
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/v1/projects")
        conn.putheader("Authorization", "Bearer " + self.token)
        conn.putheader("Content-Length", str(999_999_999))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)               # rejected before reading the body
        conn.close()

    def test_lying_content_length_times_out(self):
        tmp = tempfile.mkdtemp()
        info_path = os.path.join(tmp, "i.json")
        stdout_path = os.path.join(tmp, "daemon.stdout.log")
        stderr_path = os.path.join(tmp, "daemon.stderr.log")
        stdout = open(stdout_path, "w", encoding="utf-8")
        stderr = open(stderr_path, "w", encoding="utf-8")
        p = subprocess.Popen([sys.executable, OCD, "--workspace", tmp, "--port", "0", "--io-timeout", "2",
                              "--token-file", os.path.join(tmp, "t"), "--info-file", info_path],
                             env=dict(os.environ, OC_DAEMON_TOKEN="z" * 40), stdout=stdout, stderr=stderr, text=True)
        try:
            port = wait_for_info_file(p, info_path, timeout=10,
                                      stdout_path=stdout_path, stderr_path=stderr_path)["port"]
            import socket
            s = socket.create_connection(("127.0.0.1", port), 5)
            s.sendall(("POST /v1/projects HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAuthorization: Bearer %s\r\nContent-Length: 50\r\n\r\n{" % (port, "z" * 40)).encode())
            t0 = time.time()
            s.settimeout(10)
            try:
                data = s.recv(4096)
            except socket.timeout:
                self.fail("server never gave up on a stalled request")
            self.assertLess(time.time() - t0, 6)
            s.close()
            # daemon is still healthy afterwards
            c = Client(port, "z" * 40)
            self.assertEqual(c.call("GET", "/v1/ping")["daemon"], "0.2.0")
        finally:
            try:
                terminate_and_reap(p)
            finally:
                stdout.close()
                stderr.close()
                shutil.rmtree(tmp, ignore_errors=True)


class TestJobs(Base):
    def job(self, **body):
        body.setdefault("project", "Axiom Engine")
        j = self.c.call("POST", "/v1/jobs", body)
        return j

    def collect(self, jid, wait=30):
        seq, out, err, end = 0, [], [], None
        t0 = time.time()
        while time.time() - t0 < wait and not end:
            r = self.c.call("GET", "/v1/jobs/%s/events?since=%d&wait_ms=1000" % (jid, seq))
            seq = r["next"]
            for e in r["events"]:
                if e["type"] == "output":
                    (out if e["stream"] == "stdout" else err).append(e["data"])
                if e["type"] == "end":
                    end = e
        self.assertIsNotNone(end, "job did not finish")
        return end, "".join(out), "".join(err)

    def test_stdout_stderr_separated(self):
        j = self.job(command="echo to-out; echo to-err 1>&2; exit 4")
        end, out, err = self.collect(j["id"])
        self.assertEqual((end["status"], end["exit_code"]), ("FAILED", 4))
        self.assertEqual(out.strip(), "to-out")
        self.assertEqual(err.strip(), "to-err")

    def test_argv_no_shell_interpretation(self):
        j = self.job(argv=["echo", "$(whoami);rm -rf /;`id`"])
        end, out, err = self.collect(j["id"])
        self.assertEqual(out.strip(), "$(whoami);rm -rf /;`id`")        # argv is literal: no injection

    def test_npm_test_job(self):
        j = self.job(argv=["npm", "test"])
        end, out, err = self.collect(j["id"], 60)
        self.assertEqual(end["status"], "SUCCESS")
        self.assertIn("engine: ok", out)

    def test_failing_node_has_stderr_and_exit(self):
        j = self.job(argv=["node", "-e", "throw new Error('boom_marker')"])
        end, out, err = self.collect(j["id"])
        self.assertEqual(end["status"], "FAILED")
        self.assertNotEqual(end["exit_code"], 0)
        self.assertIn("boom_marker", err)

    def test_timeout_and_cancel(self):
        j = self.job(command="sleep 60", timeout_ms=1000)
        end, _, _ = self.collect(j["id"], 15)
        self.assertEqual(end["status"], "TIMEOUT")
        j = self.job(command="sleep 60")
        time.sleep(0.4)
        self.c.call("POST", "/v1/jobs/%s/cancel" % j["id"])
        end, _, _ = self.collect(j["id"], 15)
        self.assertEqual(end["status"], "CANCELLED")

    def test_background_job_and_stdin(self):
        j = self.job(command="cat", stdin=True)
        time.sleep(0.3)
        self.assertEqual(self.c.call("GET", "/v1/jobs/" + j["id"])["state"], "RUNNING")
        self.c.call("POST", "/v1/jobs/%s/stdin" % j["id"], {"data": "hello job\n", "close": True})
        end, out, _ = self.collect(j["id"])
        self.assertEqual(out, "hello job\n")
        self.assertEqual(end["status"], "SUCCESS")

    def test_kills_whole_process_group(self):
        j = self.job(command="sleep 55 & sleep 56 & wait", timeout_ms=800)
        end, _, _ = self.collect(j["id"], 15)
        self.assertEqual(end["status"], "TIMEOUT")
        time.sleep(0.5)
        # Match actual sleep executables, not the shell/pgrep command line that contains this pattern.
        ps = subprocess.run(["ps", "-eo", "pid=,comm=,args="], capture_output=True, text=True, timeout=5)
        left = []
        for line in ps.stdout.splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3 and fields[1] == "sleep" and fields[2].split()[:1] == ["sleep"]:
                if fields[2].split()[1:2] in (["55"], ["56"]):
                    left.append(line.strip())
        self.assertEqual(left, [], "sleep descendants survived process-group timeout: %r" % left)

    def test_spawn_failure_reported(self):
        st, err = self.c.err("POST", "/v1/jobs", {"project": "Axiom Engine", "argv": ["definitely-not-a-binary"]})
        self.assertEqual(err["code"], "SPAWN_FAILED")

    def test_job_confirmation(self):
        st, err = self.c.err("POST", "/v1/jobs", {"project": "Axiom Engine", "command": "git reset --hard"})
        self.assertEqual(err["code"], "CONFIRMATION_REQUIRED")


class TestFilesystem(Base):
    def f(self, name, **b):
        return self.c.call("POST", "/v1/fs/" + name, dict(project="Axiom Engine", **b))

    def ferr(self, name, **b):
        return self.c.err("POST", "/v1/fs/" + name, dict(project="Axiom Engine", **b))

    def test_binary_import_preserves_exact_bytes(self):
        import base64
        payload = bytes([0, 255, 1, 2, 10, 13, 128, 64]) + b"PNG\r\nasset"
        result = self.f("write_binary", path="assets/sample.bin", base64=base64.b64encode(payload).decode("ascii"), create_only=True)
        self.assertEqual(result["size"], len(payload))
        with open(os.path.join(self.root, "assets", "sample.bin"), "rb") as f:
            self.assertEqual(f.read(), payload)
        st, err = self.ferr("write_binary", path="assets/sample.bin", base64=base64.b64encode(payload).decode("ascii"), create_only=True)
        self.assertEqual(err["code"], "ALREADY_EXISTS")

    def test_binary_import_rejects_invalid_base64(self):
        st, err = self.ferr("write_binary", path="bad.bin", base64="not@@base64")
        self.assertEqual(err["code"], "INVALID_ARGUMENT")

    def test_crud_matches_disk(self):
        self.f("write", path="notes/a.txt", content="hello\n", create_only=True)
        self.assertEqual(open(os.path.join(self.root, "notes", "a.txt")).read(), "hello\n")
        r = self.f("read", path="notes/a.txt")
        self.assertEqual(r["content"], "hello\n")
        w = self.f("write", path="notes/a.txt", content="edited\n", expect_mtime_ns=r["mtime_ns"])
        self.assertEqual(open(os.path.join(self.root, "notes", "a.txt")).read(), "edited\n")
        st, err = self.ferr("write", path="notes/a.txt", content="x", create_only=True)
        self.assertEqual(err["code"], "ALREADY_EXISTS")
        st, err = self.ferr("write", path="notes/a.txt", content="stale", expect_mtime_ns=r["mtime_ns"])
        self.assertEqual(err["code"], "CONFLICT")
        self.f("rename", **{"from": "notes/a.txt", "to": "notes/b.txt"})
        self.assertFalse(os.path.exists(os.path.join(self.root, "notes", "a.txt")))
        self.f("copy", **{"from": "notes/b.txt", "to": "notes/c.txt"})
        self.assertEqual(open(os.path.join(self.root, "notes", "c.txt")).read(), "edited\n")
        self.f("mkdir", path="notes/sub/deep")
        names = [e["name"] for e in self.f("list", path="notes")["entries"]]
        self.assertEqual(names, ["sub", "b.txt", "c.txt"])
        self.assertEqual([b["name"] for b in self.f("list", path="notes/sub")["breadcrumbs"]], ["Axiom Engine", "notes", "sub"])
        st, err = self.ferr("delete", path="notes")
        self.assertEqual(err["code"], "NOT_EMPTY")
        self.f("delete", path="notes", recursive=True)
        self.assertFalse(os.path.exists(os.path.join(self.root, "notes")))

    def test_shell_and_files_api_share_the_same_disk(self):
        t = Term(self.c, "Axiom Engine")
        t.run("echo from-shell > shared.txt")
        self.assertEqual(self.f("read", path="shared.txt")["content"], "from-shell\n")
        self.f("write", path="shared2.txt", content="from-api\n")
        end, out = t.run("cat shared2.txt")
        self.assertEqual(out, "from-api\n")

    def test_path_traversal(self):
        for p in ("../x", "../../etc/passwd", "a/../../x", "/../../etc/passwd"):
            st, err = self.ferr("read", path=p)
            self.assertIn(err["code"], ("PATH_OUTSIDE_PROJECT",), p)
            st, err = self.ferr("write", path=p, content="pwn")
            self.assertEqual(err["code"], "PATH_OUTSIDE_PROJECT", p)
        self.assertFalse(os.path.exists(os.path.join(self.ws, "x")))
        st, err = self.ferr("read", path="a\0b")
        self.assertEqual(err["code"], "INVALID_PATH")
        # absolute paths are treated as project-relative, never as host paths
        st, err = self.ferr("read", path="/etc/passwd")
        self.assertEqual(err["code"], "NOT_FOUND")

    def test_symlink_escape_blocked(self):
        secret = os.path.join(self.tmp, "secret.txt")
        open(secret, "w").write("TOP-SECRET")
        os.symlink(secret, os.path.join(self.root, "evil_link"))
        os.symlink(self.tmp, os.path.join(self.root, "evil_dir"))
        st, err = self.ferr("read", path="evil_link")
        self.assertEqual(err["code"], "PATH_OUTSIDE_PROJECT")
        st, err = self.ferr("read", path="evil_dir/secret.txt")
        self.assertEqual(err["code"], "PATH_OUTSIDE_PROJECT")
        st, err = self.ferr("write", path="evil_link", content="overwritten")
        self.assertEqual(err["code"], "PATH_OUTSIDE_PROJECT")
        self.assertEqual(open(secret).read(), "TOP-SECRET")
        ents = {e["name"]: e for e in self.f("list")["entries"]}
        self.assertTrue(ents["evil_link"]["outside_project"])
        self.f("delete", path="evil_link")                       # deleting the link must not delete the target
        self.f("delete", path="evil_dir")
        self.assertTrue(os.path.exists(secret))
        self.assertTrue(os.path.isdir(self.tmp))

    def test_missing_binary_large_permissions(self):
        st, err = self.ferr("read", path="nope.txt")
        self.assertEqual((st, err["code"]), (404, "NOT_FOUND"))
        open(os.path.join(self.root, "bin.dat"), "wb").write(b"\x00\x01\x02" * 100)
        r = self.f("read", path="bin.dat")
        self.assertTrue(r["binary"])
        self.assertIsNone(r["content"])
        open(os.path.join(self.root, "big.txt"), "w").write("line\n" * 400000)          # ~2 MB
        r = self.f("read", path="big.txt")
        self.assertTrue(r["truncated"])
        self.assertLessEqual(r["bytes"], 1024 * 1024)
        r2 = self.f("read", path="big.txt", offset=r["bytes"], limit=4096)
        with open(os.path.join(self.root, "big.txt"), "rb") as fh:
            fh.seek(r["bytes"])
            self.assertEqual(r2["content"].encode(), fh.read(4096))                      # exact bytes from disk at that offset
        st, err = self.ferr("write", path="huge.txt", content="a" * (9 * 1024 * 1024))
        self.assertEqual(err["code"], "FILE_TOO_LARGE")
        if os.geteuid() != 0:
            os.chmod(os.path.join(self.root, "big.txt"), 0)
            st, err = self.ferr("read", path="big.txt")
            self.assertEqual(err["code"], "PERMISSION_DENIED")
            os.chmod(os.path.join(self.root, "big.txt"), 0o644)
        st, err = self.ferr("read", path="src")
        self.assertEqual(err["code"], "IS_DIRECTORY")
        st, err = self.ferr("delete", path="")
        self.assertEqual(err["code"], "INVALID_PATH")

    def test_utf8_boundary_read(self):
        open(os.path.join(self.root, "u.txt"), "w", encoding="utf-8").write("é" * 1000)
        r = self.f("read", path="u.txt", limit=501)
        self.assertFalse(r["lossy"])
        self.assertEqual(r["content"], "é" * 250)

    def test_search(self):
        self.f("write", path="src/findme.js", content="const NEEDLE_VALUE = 1;\n// other\n")
        r = self.f("search", query="needle_value")
        hits = [(x["path"], x["line"]) for x in r["results"]]
        self.assertIn(("src/findme.js", 1), hits)
        r = self.f("search", query="findme")
        self.assertTrue(any(x["line"] == 0 and x["path"] == "src/findme.js" for x in r["results"]))
        self.assertFalse(any(x["path"].startswith(".git/") for x in self.f("search", query="init")["results"]))
        st, err = self.ferr("search", query="(", regex=True)
        self.assertEqual(err["code"], "INVALID_ARGUMENT")

    def test_git_dir_hidden_and_projects(self):
        self.assertNotIn(".git", [e["name"] for e in self.f("list")["entries"]])
        self.assertIn("Axiom Engine", [p["name"] for p in self.c.call("GET", "/v1/projects")])
        caps = self.c.call("GET", "/v1/projects/capabilities")
        self.assertTrue(caps["customProjectParents"])
        self.assertTrue(caps["strictParent"])
        self.assertTrue(caps["openExistingProjects"])
        st, err = self.c.err("POST", "/v1/projects", {"name": "Must Not Fall Back", "require_parent": True})
        self.assertEqual(err["code"], "INVALID_PATH")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "Must Not Fall Back")))
        st, err = self.c.err("POST", "/v1/projects", {"name": "../evil"})
        self.assertEqual(err["code"], "INVALID_ARGUMENT")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "..", "evil")))

    def test_open_existing_project_registers_exact_folder_without_nesting(self):
        external = tempfile.mkdtemp(prefix="SIExistingProject-", dir=os.path.expanduser("~"))
        project_name = os.path.basename(external)
        marker = os.path.join(external, "existing-file.txt")
        with open(marker, "w", encoding="utf-8") as f:
            f.write("keep this file")
        try:
            result = self.c.call("POST", "/v1/projects/open-existing", {"name": project_name, "path": external})
            self.assertEqual(os.path.realpath(result["path"]), os.path.realpath(external))
            self.assertTrue(os.path.isfile(marker))
            self.assertFalse(os.path.exists(os.path.join(external, project_name)))
            projects = self.c.call("GET", "/v1/projects")
            self.assertTrue(any(p["id"] == project_name and p["openedExisting"] and os.path.realpath(p["path"]) == os.path.realpath(external) for p in projects))
            # A single physical folder must not be registered under a second project identity.
            status, duplicate = self.c.err("POST", "/v1/projects/open-existing", {"name": project_name + " Alias", "path": external})
            self.assertEqual(status, 409)
            self.assertEqual(duplicate["code"], "PROJECT_PATH_ALREADY_OPEN")
            listed = self.c.call("POST", "/v1/fs/list", {"project": project_name, "path": ""})
            self.assertIn("existing-file.txt", [e["name"] for e in listed["entries"]])
            removed = self.c.call("POST", "/v1/projects/delete", {"id": project_name})
            self.assertTrue(removed["removedFromSi"])
            self.assertTrue(os.path.isfile(marker), "removing project shortcut must preserve original files")
        finally:
            mapping_path = os.path.join(self.ws, ".si-project-paths.json")
            existing_path = os.path.join(self.ws, ".si-opened-existing.json")
            try:
                with open(mapping_path, "r", encoding="utf-8") as f: mapping = json.load(f)
                mapping.pop(project_name, None)
                with open(mapping_path, "w", encoding="utf-8") as f: json.dump(mapping, f, ensure_ascii=False, sort_keys=True)
                with open(existing_path, "r", encoding="utf-8") as f: names = json.load(f)
                with open(existing_path, "w", encoding="utf-8") as f: json.dump([n for n in names if n != project_name], f)
            except (OSError, ValueError):
                pass
            shutil.rmtree(external, ignore_errors=True)

    def test_project_rename_and_delete(self):
        self.c.call("POST", "/v1/projects", {"name": "Project Ops Test"})
        renamed = self.c.call("POST", "/v1/projects/rename", {"id": "Project Ops Test", "name": "Project Ops Renamed"})
        self.assertEqual(renamed["id"], "Project Ops Renamed")
        self.assertTrue(os.path.isdir(os.path.join(self.ws, "Project Ops Renamed")))
        self.assertFalse(os.path.exists(os.path.join(self.ws, "Project Ops Test")))
        deleted = self.c.call("POST", "/v1/projects/delete", {"id": "Project Ops Renamed"})
        self.assertTrue(deleted["deleted"])
        self.assertFalse(os.path.exists(os.path.join(self.ws, "Project Ops Renamed")))
        st, err = self.c.err("POST", "/v1/projects/delete", {"id": "../outside"})
        self.assertEqual(err["code"], "INVALID_ARGUMENT")


class TestHealth(Base):
    def test_health_is_real(self):
        h = self.c.call("GET", "/v1/health?network=0")
        by = {c["key"]: c for c in h["checks"]}
        for k in ("termux", "os", "arch", "node", "npm", "python", "git", "shell", "pty", "workspace", "storage", "process"):
            self.assertIn(k, by)
        self.assertEqual(by["node"]["status"], "ok")
        self.assertIn("v", by["node"]["detail"])
        self.assertEqual(by["pty"]["status"], "ok")
        self.assertEqual(by["workspace"]["detail"], os.path.realpath(self.ws))
        # this sandbox is not Termux/Android: the engine must say so rather than reporting green
        self.assertEqual(by["termux"]["status"], "warning")
        self.assertNotEqual(h["status"], "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
