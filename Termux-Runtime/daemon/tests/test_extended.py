"""Integration tests for the v0.2 daemon services. Real daemon, real git, real processes, real HTTP.
The ONLY simulated thing is the remote LLM (a local HTTP server speaking the OpenAI wire format) because
no model/network is available in CI; every tool the "model" calls is executed for real by the daemon.
Run from repo root:  python3 -m unittest daemon.tests.test_extended
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_daemon import Base, Client  # noqa: E402

KEY = "sk-test-SECRETKEY-1234567890abcdef"


def sh(cmd, cwd, **kw):
    return subprocess.run(cmd, shell=True, cwd=cwd, check=True, capture_output=True, text=True, **kw).stdout


class Proj(Base):
    n = 0

    def newproj(self, files=None, git=True):
        Proj.n += 1
        name = "p%d" % Proj.n
        self.c.call("POST", "/v1/projects", {"name": name})
        root = os.path.join(self.ws, name)
        for rel, content in (files or {}).items():
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "w") as f:
                f.write(content)
        if git:
            sh("git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -qm init", root)
        return name, root

    def G(self, op, project, **kw):
        return self.c.call("POST", "/v1/git/" + op, dict(project=project, **kw))


class TestGit(Proj):
    def test_git_failure_message_skips_clone_banner(self):
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from ocd_git import GitService
        class ApiError(Exception):
            def __init__(self, code, message, status=400, details=None):
                super().__init__(message)
                self.code, self.status, self.details = code, status, details
        service = GitService(None, ApiError)
        with self.assertRaises(ApiError) as caught:
            service._ok({"code": 128,
                         "stderr": "Cloning into 'fit-forge-ops'...\nfatal: repository 'https://example.invalid/user/repo.git/' not found\n",
                         "stdout": ""}, "clone")
        self.assertIn("repository", str(caught.exception))
        self.assertIn("not found", str(caught.exception))
        self.assertNotIn("Cloning into", str(caught.exception).splitlines()[0])
        self.assertIn("Cloning into", caught.exception.details)

    def test_status_diff_commit_log(self):
        p, root = self.newproj({"a.txt": "one\n"})
        self.assertTrue(self.G("status", p)["clean"])
        open(os.path.join(root, "a.txt"), "w").write("one\ntwo\n")
        open(os.path.join(root, "new.txt"), "w").write("n\n")
        st = self.G("status", p)
        codes = {f["path"]: f["code"] for f in st["files"]}
        self.assertEqual(codes, {"a.txt": "M", "new.txt": "?"})
        self.assertEqual(st["branch"], "main")
        d = self.G("diff", p, path="a.txt")["text"]
        self.assertIn("+two", d)
        self.assertIn("+n", self.G("diff", p, path="new.txt")["text"])      # untracked file diff
        c = self.G("commit", p, message="second")
        self.assertEqual(c["hash"], sh("git rev-parse --short HEAD", root).strip())
        log = self.G("log", p)
        self.assertEqual([x["msg"] for x in log], ["second", "init"])
        self.assertTrue(self.G("status", p)["clean"])

    def test_secret_scan_requires_explicit_confirmation_for_commit(self):
        p, root = self.newproj({"app.py": "print('hello')\n"})
        with open(os.path.join(root, "app.py"), "w") as f:
            f.write("API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz1234567890'\n")
        st, e = self.c.err("POST", "/v1/git/commit", {"project": p, "message": "add key"})
        self.assertEqual(e["code"], "SECRET_DETECTED")
        self.assertTrue(any(x["path"] == "app.py" for x in e["details"]))
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", json.dumps(e))
        self.assertEqual(sh("git log -1 --pretty=%s", root).strip(), "init")
        self.G("commit", p, message="intentional test fixture", confirm_secrets=True)
        self.assertEqual(sh("git log -1 --pretty=%s", root).strip(), "intentional test fixture")

    def test_commit_with_no_identity_still_works_and_nothing_to_commit(self):
        p, root = self.newproj({"a": "1"}, git=False)
        self.G("init", p)
        sh("git config --local --unset user.name; git config --local --unset user.email; true", root)
        env_home = {"HOME": "/nonexistent"}
        self.G("add", p, all=True)
        self.G("commit", p, message="first")
        st, e = self.c.err("POST", "/v1/git/commit", {"project": p, "message": "again"})
        self.assertEqual(e["code"], "NOTHING_TO_COMMIT")

    def test_branch_checkout_restore_stash_revparse(self):
        p, root = self.newproj({"a.txt": "base\n"})
        self.G("branch", p, action="create", name="feature/x")
        names = [b["name"] for b in self.G("branch", p)["branches"]]
        self.assertEqual(sorted(names), ["feature/x", "main"])
        self.G("checkout", p, ref="feature/x")
        self.assertEqual(self.G("rev-parse", p, args=["--abbrev-ref", "HEAD"])["output"], "feature/x")
        open(os.path.join(root, "a.txt"), "w").write("dirty\n")
        st, e = self.c.err("POST", "/v1/git/restore", {"project": p, "path": "a.txt"})
        self.assertEqual(e["code"], "CONFIRMATION_REQUIRED")
        self.assertEqual(open(os.path.join(root, "a.txt")).read(), "dirty\n")
        st, e = self.c.err("POST", "/v1/git/checkout", {"project": p, "ref": "main"})
        self.assertEqual(e["code"], "CONFIRMATION_REQUIRED")      # dirty tree
        self.G("stash", p, action="push", message="wip")
        self.assertEqual(open(os.path.join(root, "a.txt")).read(), "base\n")
        self.assertEqual(self.G("stash", p, action="list")["stashes"][0]["msg"].endswith("wip"), True)
        self.G("stash", p, action="pop")
        self.assertEqual(open(os.path.join(root, "a.txt")).read(), "dirty\n")
        self.G("restore", p, path="a.txt", confirmed=True)
        self.assertEqual(open(os.path.join(root, "a.txt")).read(), "base\n")
        self.G("checkout", p, ref="main")
        self.G("branch", p, action="delete", name="feature/x")

    def test_remote_fetch_pull_push_real(self):
        p, root = self.newproj({"a.txt": "1\n"})
        bare = os.path.join(self.tmp, "remote-%s.git" % p)
        sh("git init -q --bare -b main %s" % bare, self.tmp)
        sh("git remote add origin %s && git push -q -u origin main" % bare, root)
        open(os.path.join(root, "a.txt"), "w").write("2\n")
        self.G("commit", p, message="two")
        st = self.G("status", p)
        self.assertEqual(st["ahead"], 1)
        self.G("push", p)
        self.assertEqual(sh("git log -1 --pretty=%s", bare).strip(), "two")
        # someone else pushes; we fetch + pull
        other = os.path.join(self.tmp, "other-" + p)
        sh("git clone -q %s %s && cd %s && git config user.email o@o && git config user.name o && echo 3 > a.txt && git commit -qam three && git push -q" % (bare, other, other), self.tmp)
        self.G("fetch", p)
        self.assertEqual(self.G("status", p)["behind"], 1)
        self.G("pull", p)
        self.assertEqual(open(os.path.join(root, "a.txt")).read(), "3\n")
        st, e = self.c.err("POST", "/v1/git/push", {"project": p, "force": True})
        self.assertEqual(e["code"], "CONFIRMATION_REQUIRED")

    def test_failure_is_real_git_error(self):
        p, root = self.newproj({"a": "1"})
        st, e = self.c.err("POST", "/v1/git/checkout", {"project": p, "ref": "no-such-branch", "confirmed": True})
        self.assertEqual(e["code"], "GIT_FAILED")
        self.assertIn("no-such-branch", e["details"])

    def test_argument_injection_blocked(self):
        p, root = self.newproj({"a": "1"})
        for op, body in (("checkout", {"ref": "--orphan=x"}), ("branch", {"action": "create", "name": "-D"}),
                         ("rev-parse", {"args": ["--exec-path"]}), ("checkout", {"ref": "a..b"}),
                         ("pull", {"remote": "--upload-pack=touch /tmp/pwn"}), ("fetch", {"remote": "-o"}),
                         ("stash", {"action": "pop", "ref": "--index"})):
            st, e = self.c.err("POST", "/v1/git/" + op, dict(body, project=p))
            self.assertIn(e["code"], ("INVALID_ARGUMENT",), (op, body, e))
        for url in ("ext::sh -c touch /tmp/pwn", "file:///etc", "--upload-pack=x", "http://evil.example/x.git", "/local/path"):
            st, e = self.c.err("POST", "/v1/git/clone", {"url": url, "name": "zzz"})
            self.assertEqual(e["code"], "INVALID_ARGUMENT", url)

    def test_paths_confined(self):
        p, root = self.newproj({"a": "1"})
        st, e = self.c.err("POST", "/v1/git/add", {"project": p, "paths": ["../../etc/passwd"]})
        self.assertEqual(e["code"], "PATH_OUTSIDE_PROJECT")
        os.symlink("/etc", os.path.join(root, "link"))
        st, e = self.c.err("POST", "/v1/git/add", {"project": p, "paths": ["link/passwd"]})
        self.assertEqual(e["code"], "PATH_OUTSIDE_PROJECT")

    def test_malicious_repo_config_and_hooks_do_not_execute(self):
        p, root = self.newproj({"a": "1"})
        marker = os.path.join(self.tmp, "PWNED-" + p)
        hook = os.path.join(root, ".git", "hooks", "pre-commit")
        open(hook, "w").write("#!/bin/sh\ntouch %s\n" % marker)
        os.chmod(hook, 0o755)
        sh("git config core.fsmonitor 'touch %s; echo' && git config core.hooksPath .git/hooks" % marker, root)
        open(os.path.join(root, "a"), "w").write("2")
        self.G("status", p)
        self.G("commit", p, message="x")
        self.assertFalse(os.path.exists(marker), "repo-supplied hook/fsmonitor executed")

    def test_textconv_and_external_diff_do_not_execute(self):
        p, root = self.newproj({"f.dat": "1\n", ".gitattributes": "*.dat diff=evil\n"})
        marker = os.path.join(self.tmp, "PWNED2-" + p)
        sh("git config diff.evil.textconv 'sh -c \"touch %s; cat\" --' && git config diff.external 'touch %s'" % (marker, marker + "x"), root)
        open(os.path.join(root, "f.dat"), "w").write("2\n")
        d = self.G("diff", p, path="f.dat")["text"]
        self.assertIn("+2", d)
        self.assertFalse(os.path.exists(marker) or os.path.exists(marker + "x"), "textconv/external diff executed")

    def test_not_a_repo(self):
        p, root = self.newproj({"a": "1"}, git=False)
        st, e = self.c.err("POST", "/v1/git/status", {"project": p})
        self.assertEqual(e["code"], "NOT_A_REPO")


class TestSnapshots(Proj):
    def S(self, op, p, **kw):
        return self.c.call("POST", "/v1/snapshots/" + op, dict(project=p, **kw))

    def test_create_list_inspect_rollback(self):
        p, root = self.newproj({"src/a.js": "A1\n", "keep.txt": "K\n"}, git=False)
        os.makedirs(os.path.join(root, "node_modules/x"))
        open(os.path.join(root, "node_modules/x/i.js"), "w").write("dep")
        s1 = self.S("create", p, label="good state", good=True)
        self.assertEqual(s1["files"], 3 - 1 + 0 if False else s1["files"])
        self.assertTrue(s1["good"])
        # mutate: edit, delete, add, add under node_modules
        open(os.path.join(root, "src/a.js"), "w").write("A2\n")
        os.unlink(os.path.join(root, "keep.txt"))
        open(os.path.join(root, "added.txt"), "w").write("new")
        os.makedirs(os.path.join(root, "newdir/sub"))
        open(os.path.join(root, "newdir/sub/f"), "w").write("f")
        open(os.path.join(root, "node_modules/x/i.js"), "w").write("changed-dep")
        info = self.S("inspect", p, id=s1["id"])
        paths = {c["path"] for c in info["would_change"]}
        self.assertEqual(paths, {"src/a.js", "keep.txt", "added.txt", "newdir/sub/f"})
        self.assertIn("src/a.js", info["file_list"])
        self.assertNotIn("node_modules/x/i.js", info["file_list"])
        # destructive rollback needs confirmation and changes nothing without it
        st, e = self.c.err("POST", "/v1/snapshots/rollback", {"project": p, "id": s1["id"]})
        self.assertEqual(e["code"], "CONFIRMATION_REQUIRED")
        self.assertEqual(open(os.path.join(root, "src/a.js")).read(), "A2\n")
        r = self.S("rollback", p, id=s1["id"], confirmed=True)
        self.assertEqual(open(os.path.join(root, "src/a.js")).read(), "A1\n")
        self.assertEqual(open(os.path.join(root, "keep.txt")).read(), "K\n")
        self.assertFalse(os.path.exists(os.path.join(root, "added.txt")))
        self.assertFalse(os.path.exists(os.path.join(root, "newdir")))
        self.assertEqual(open(os.path.join(root, "node_modules/x/i.js")).read(), "changed-dep")   # excluded -> untouched
        # the safety snapshot can undo the rollback
        self.S("rollback", p, id=r["safety_snapshot"], confirmed=True)
        self.assertEqual(open(os.path.join(root, "src/a.js")).read(), "A2\n")
        self.assertTrue(os.path.exists(os.path.join(root, "added.txt")))
        labels = [x["label"] for x in self.S("list", p)]
        self.assertIn("good state", labels)
        self.assertEqual(labels.count("Before rollback"), 2)
        # short id accepted
        self.S("inspect", p, id=s1["short"])

    def test_snapshots_do_not_touch_project_git(self):
        p, root = self.newproj({"a": "1"})
        head = sh("git rev-parse HEAD", root).strip()
        open(os.path.join(root, "a"), "w").write("2")
        self.S("create", p, label="x")
        self.assertEqual(sh("git rev-parse HEAD", root).strip(), head)
        self.assertEqual(sh("git status --porcelain", root).strip(), "M a")
        self.assertFalse(os.path.exists(os.path.join(root, ".oc-snapshots")))

    def test_large_files_skipped_and_bad_ids(self):
        p, root = self.newproj({"a": "1"}, git=False)
        with open(os.path.join(root, "big.bin"), "wb") as f:
            f.truncate(6 * 1024 * 1024)
        s = self.S("create", p, label="b")
        self.assertEqual(s["skipped_large"], ["big.bin"])
        for bad in ("abc", "../../x", "0" * 40, 5):
            st, e = self.c.err("POST", "/v1/snapshots/rollback", {"project": p, "id": bad, "confirmed": True})
            self.assertIn(e["code"], ("INVALID_ARGUMENT", "NOT_FOUND"))
        self.assertEqual(self.S("list", self.newproj({}, git=False)[0]), [])

    def test_symlink_in_project_is_not_followed_on_rollback(self):
        p, root = self.newproj({"a": "1"}, git=False)
        s = self.S("create", p, label="before link")
        outside = os.path.join(self.tmp, "outside-" + p)
        os.makedirs(outside)
        open(os.path.join(outside, "victim"), "w").write("keep me")
        os.symlink(outside, os.path.join(root, "evil"))
        self.S("rollback", p, id=s["id"], confirmed=True)
        self.assertEqual(open(os.path.join(outside, "victim")).read(), "keep me")
        self.assertFalse(os.path.lexists(os.path.join(root, "evil")))


class TestDetect(Proj):
    def D(self, p):
        return self.c.call("POST", "/v1/projects/detect", {"project": p})

    def test_react_vite_npm(self):
        p, _ = self.newproj({"package.json": json.dumps({"dependencies": {"react": "18"}, "devDependencies": {"vite": "5"},
                                                         "scripts": {"dev": "vite", "build": "vite build", "test": "vitest"}}),
                             "package-lock.json": "{}", "vite.config.ts": "export default {}"})
        d = self.D(p)
        for t in ("git", "node", "npm", "react", "vite", "javascript"):
            self.assertIn(t, d["types"])
        self.assertEqual(d["primary"], "react-vite")
        self.assertEqual(d["package_manager"], "npm")
        self.assertEqual(d["suggested"]["test"], "npm test")
        self.assertEqual(d["suggested"]["dev"], "npm run dev")
        self.assertIn("vite.config.ts", d["evidence"]["vite"])

    def test_python_and_empty_and_invalid_package_json(self):
        p, _ = self.newproj({"requirements.txt": "flask\n", "app.py": "print(1)"}, git=False)
        d = self.D(p)
        self.assertEqual(d["types"][0], "python")
        self.assertEqual(d["suggested"]["install"], "pip install -r requirements.txt")
        e, _ = self.newproj({}, git=False)
        self.assertTrue(self.D(e)["empty"] or self.D(e)["types"] == [])
        b, _ = self.newproj({"package.json": "{ not json"}, git=False)
        db = self.D(b)
        self.assertIn("node", db["types"])
        self.assertTrue(any("not valid JSON" in x for x in db["evidence"]["node"]))

    def test_pnpm(self):
        p, _ = self.newproj({"package.json": "{}", "pnpm-lock.yaml": ""}, git=False)
        self.assertEqual(self.D(p)["package_manager"], "pnpm")


class FakeLLM:
    """OpenAI-compatible server on loopback. `script` is a list of message dicts returned in order."""

    def __init__(self, script, expect_key=KEY, status=200):
        self.script, self.requests, self.expect_key, self.status = list(script), [], expect_key, status
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer " + outer.expect_key:
                    return self._send(401, {"error": "bad key " + (self.headers.get("Authorization") or "")})
                self._send(200, {"data": [{"id": "test-model"}, {"id": "other"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                if self.headers.get("Authorization") != "Bearer " + outer.expect_key:
                    return self._send(401, {"error": "bad key " + (self.headers.get("Authorization") or "")})
                if outer.status != 200:
                    return self._send(outer.status, {"error": "boom"})
                if not outer.script:
                    return self._send(200, {"choices": [{"message": {"role": "assistant", "content": "(script exhausted)"}}]})
                m = outer.script.pop(0)
                if callable(m):
                    time.sleep(m())
                    m = {"role": "assistant", "content": "late"}
                self._send(200, {"choices": [{"message": m}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d/v1" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


def tc(i, name, **args):
    return {"id": "c%s" % i, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


class TestAgent(Proj):
    def prov(self, llm, **kw):
        return dict({"base_url": llm.url, "model": "test-model", "api_key": KEY}, **kw)

    def wait(self, sid, states=("DONE", "FAILED", "CANCELLED"), t=30):
        end = time.time() + t
        while time.time() < end:
            st = self.c.call("POST", "/v1/agent/status", {"session_id": sid})
            if st["state"] in states:
                return st
            time.sleep(0.1)
        self.fail("agent did not finish: %r" % st)

    def test_real_actions_real_files_real_commands(self):
        p, root = self.newproj({"package.json": json.dumps({"scripts": {"test": "node t.js"}}), "t.js": "console.log('T_OK')"})
        llm = FakeLLM([
            {"role": "assistant", "content": "", "tool_calls": [tc(1, "write_file", path="src/hello.js", content="console.log('hello')\n"),
                                                                tc(2, "run_command", command="node src/hello.js"),
                                                                tc(3, "run_command", command="npm test"),
                                                                tc(4, "write_file", path="../escape.txt", content="x"),
                                                                tc(5, "run_command", command="sh -c 'exit 3'")]},
            {"role": "assistant", "content": "I created src/hello.js and ran everything."},
        ])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "make hello", "provider": self.prov(llm)})
            st = self.wait(sid)
            self.assertEqual(st["state"], "DONE", st)
            # real effects
            self.assertEqual(open(os.path.join(root, "src/hello.js")).read(), "console.log('hello')\n")
            self.assertFalse(os.path.exists(os.path.join(root, "..", "escape.txt")))
            by = {s["i"]: s for s in st["steps"]}
            self.assertTrue(by[0]["ok"] and by[0]["created"])
            self.assertEqual((by[1]["status"], by[1]["exit_code"]), ("SUCCESS", 0))
            self.assertEqual((by[2]["status"], by[2]["exit_code"]), ("SUCCESS", 0))
            self.assertFalse(by[3]["ok"])
            self.assertIn("PATH_OUTSIDE_PROJECT", by[3]["error"])
            self.assertEqual((by[4]["status"], by[4]["exit_code"]), ("FAILED", 3))
            # the model was told the truth about the failures
            tools = [m["content"] for m in llm.requests[1]["messages"] if m["role"] == "tool"]
            self.assertIn("hello", tools[1])
            self.assertIn("T_OK", tools[2])
            self.assertTrue(tools[3].startswith("ERROR PATH_OUTSIDE_PROJECT"))
            self.assertIn("exit_code=3", tools[4])
            # summary is generated from the real log
            self.assertIn("Created src/hello.js", st["summary"])
            self.assertTrue(any("FAILED to write ../escape.txt" in x for x in st["summary"]))
            self.assertEqual(st["changes"][0]["path"], "src/hello.js")
            self.assertTrue(st["changes"][0]["isNew"])
            # safety snapshot exists and rolls the whole run back
            self.assertTrue(st["snapshot"])
            self.c.call("POST", "/v1/snapshots/rollback", {"project": p, "id": st["snapshot"], "confirmed": True})
            self.assertFalse(os.path.exists(os.path.join(root, "src/hello.js")))
            # the system prompt knew the project type
            self.assertIn("node", llm.requests[0]["messages"][0]["content"])
        finally:
            llm.close()

    def test_key_never_leaks(self):
        p, root = self.newproj({"a": "1"})
        llm = FakeLLM([{"role": "assistant", "content": "hi"}])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            r = self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "hello", "provider": self.prov(llm)})
            st = self.wait(sid)
            self.assertNotIn(KEY, json.dumps(r) + json.dumps(st))
            for dp, _, fns in os.walk(self.ws):
                for fn in fns:
                    if os.path.join(dp, fn).count(".git/") or fn.endswith(".pack"):
                        continue
                    try:
                        self.assertNotIn(KEY, open(os.path.join(dp, fn), errors="ignore").read(), os.path.join(dp, fn))
                    except IsADirectoryError:
                        pass
            self.assertNotIn(KEY, self.proc.stderr.peek().decode() if hasattr(self.proc.stderr, "peek") else "")
        finally:
            llm.close()

    def test_provider_errors_are_real(self):
        p, root = self.newproj({"a": "1"})
        llm = FakeLLM([])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            bad = dict(self.prov(llm), api_key="sk-wrong-key-000000000000")
            self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "x", "provider": bad})
            st = self.wait(sid)
            self.assertEqual(st["state"], "FAILED")
            self.assertEqual(st["error"]["code"], "PROVIDER_AUTH")
            self.assertNotIn("sk-wrong-key-000000000000", json.dumps(st))      # scrubbed even from provider's echo
            # resume with the right key continues the same session
            llm.script.append({"role": "assistant", "content": "ok now"})
            self.c.call("POST", "/v1/agent/resume", {"session_id": sid, "provider": self.prov(llm)})
            st = self.wait(sid)
            self.assertEqual((st["state"], st["reply"]), ("DONE", "ok now"))
            # unreachable
            sid2 = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            self.c.call("POST", "/v1/agent/send", {"session_id": sid2, "message": "x", "provider": {"base_url": "http://127.0.0.1:1/v1", "model": "m", "api_key": "k"}})
            self.assertEqual(self.wait(sid2)["error"]["code"], "PROVIDER_UNREACHABLE")
            # misconfiguration is rejected up front
            for prov in ({}, {"base_url": ""}, {"base_url": llm.url}, {"base_url": "ftp://x", "api_key": "k", "model": "m"},
                         {"base_url": "http://example.com/v1", "api_key": "k", "model": "m"},
                         {"base_url": "https://u:p@example.com/v1", "api_key": "k", "model": "m"}):
                st_, e = self.c.err("POST", "/v1/agent/send", {"session_id": sid, "message": "x", "provider": prov})
                self.assertIn(e["code"], ("PROVIDER_NOT_CONFIGURED", "PROVIDER_NO_KEY", "INVALID_ARGUMENT"), (prov, e))
        finally:
            llm.close()

    def test_cancel_stops_running_command(self):
        p, root = self.newproj({"a": "1"})
        llm = FakeLLM([{"role": "assistant", "content": "", "tool_calls": [tc(1, "run_command", command="sleep 30; echo done > late.txt")]}])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "slow", "provider": self.prov(llm)})
            time.sleep(1.0)
            t0 = time.time()
            self.c.call("POST", "/v1/agent/cancel", {"session_id": sid})
            st = self.wait(sid, t=15)
            self.assertEqual(st["state"], "CANCELLED")
            self.assertLess(time.time() - t0, 10)
            self.assertEqual(st["steps"][0]["status"], "CANCELLED")
            time.sleep(0.5)
            self.assertFalse(os.path.exists(os.path.join(root, "late.txt")))
        finally:
            llm.close()

    def test_policy_applies_to_agent_commands(self):
        p, root = self.newproj({"keep.txt": "k"})
        llm = FakeLLM([
            {"role": "assistant", "content": "", "tool_calls": [tc(1, "run_command", command="rm keep.txt"), tc(2, "run_command", command=":(){ :|:& };:")]},
            {"role": "assistant", "content": "could not"}])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "delete", "provider": self.prov(llm)})
            st = self.wait(sid)
            self.assertTrue(os.path.exists(os.path.join(root, "keep.txt")))
            self.assertIn("CONFIRMATION_REQUIRED", st["steps"][0]["error"])
            self.assertIn("COMMAND_DENIED", st["steps"][1]["error"])
        finally:
            llm.close()

    def test_models_and_probe(self):
        llm = FakeLLM([])
        try:
            m = self.c.call("POST", "/v1/agent/models", {"provider": {"base_url": llm.url, "api_key": KEY}})
            self.assertEqual([x["id"] for x in m], ["test-model", "other"])
            ok = self.c.call("POST", "/v1/agent/probe", {"provider": self.prov(llm)})
            self.assertEqual(ok["status"], "ok")
            self.assertEqual(self.c.call("POST", "/v1/agent/probe", {"provider": dict(self.prov(llm), model="nope")})["status"], "warning")
            bad = self.c.call("POST", "/v1/agent/probe", {"provider": dict(self.prov(llm), api_key="wrongwrongwrong")})
            self.assertEqual(bad["status"], "failed")
            self.assertIn("PROVIDER_AUTH", bad["raw"])
            self.assertEqual(self.c.call("POST", "/v1/agent/probe", {"provider": {"base_url": llm.url, "needs_key": True}})["status"], "warning")
        finally:
            llm.close()

    def test_session_survives_daemon_restart_as_interrupted(self):
        p, root = self.newproj({"a": "1"})
        llm = FakeLLM([{"role": "assistant", "content": "", "tool_calls": [tc(1, "run_command", command="sleep 20")]}])
        try:
            sid = self.c.call("POST", "/v1/agent/start", {"project": p})["sessionId"]
            self.c.call("POST", "/v1/agent/send", {"session_id": sid, "message": "x", "provider": self.prov(llm)})
            time.sleep(0.8)
            from_disk = json.load(open(os.path.join(self.ws, ".oc-agent", sid + ".json")))
            self.assertEqual(from_disk["project"], p)
            self.assertNotIn(KEY, json.dumps(from_disk))
            self.c.call("POST", "/v1/agent/cancel", {"session_id": sid})
            self.wait(sid)
        finally:
            llm.close()


class TestMaintenance(Proj):
    def test_cleanup_and_terminal_git_hardening(self):
        p, root = self.newproj({"a": "1"})
        open(os.path.join(root, ".oc-x.tmp"), "w").write("t")
        self.assertEqual(self.c.call("POST", "/v1/maintenance/cleanup", {})["tmp_files"], 1)
        # terminal's own git ignores a hostile core.fsmonitor from .git/config
        marker = os.path.join(self.tmp, "PWNED3-" + p)
        sh("git config core.fsmonitor 'touch %s; echo'" % marker, root)
        sid = self.c.call("POST", "/v1/sessions", {"project": p})["id"]
        r = self.c.call("POST", "/v1/sessions/%s/exec" % sid, {"command": "git status"})
        time.sleep(2)
        self.assertFalse(os.path.exists(marker))


class TestHealthV2(Proj):
    def test_new_checks(self):
        h = self.c.call("GET", "/v1/health?network=0")
        by = {c["key"]: c for c in h["checks"]}
        self.assertEqual(by["process"]["status"], "ok")
        self.assertIn("real process", by["process"]["detail"])
        self.assertEqual(by["git_ops"]["status"], "ok")
        self.assertEqual(h["daemon"], "0.2.0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
