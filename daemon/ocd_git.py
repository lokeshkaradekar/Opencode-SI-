"""ocd_git.py - real Git operations for ocd.py.

Rules (security):
  * git is always run as an argv list, never through a shell, so no argument is re-parsed.
  * every ref / remote / URL / path argument is validated; nothing user-supplied may start with "-".
  * paths are resolved through Workspace.resolve (project-confined, symlink-safe) and passed after "--".
  * repo-local config cannot run code: hooks are disabled and fsmonitor / external diff / pager are neutralised.
  * network commands run with GIT_TERMINAL_PROMPT=0 (never hang on a credential prompt) and a hard timeout.
Output is the real output of git; a non-zero exit becomes a GIT_FAILED error carrying git's own stderr.
"""
import os
import re
import subprocess
import time

REF_RE = re.compile(r"^(?!-)[A-Za-z0-9._/@{}^~+:-]{1,200}$")
REMOTE_RE = re.compile(r"^(?!-)[A-Za-z0-9._-]{1,64}$")
URL_RE = re.compile(r"^(https://[A-Za-z0-9._~%@:/+-]{3,500}|ssh://[A-Za-z0-9._~%@:/+-]{3,500}|git@[A-Za-z0-9._-]+:[A-Za-z0-9._~%/+-]{1,400})$")
REV_FLAGS = {"--abbrev-ref", "--show-toplevel", "--is-inside-work-tree", "--git-dir", "--short", "--verify",
             "--show-prefix", "--is-bare-repository", "--symbolic-full-name"}
OUT_CAP = 2 * 1024 * 1024
NET_TIMEOUT = 120
LOCAL_TIMEOUT = 30

# Neutralise config that could execute code from inside a hostile repository.
SAFE_CFG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat",
            "-c", "core.sshCommand=ssh -o BatchMode=yes", "-c", "protocol.ext.allow=never",
            "-c", "protocol.file.allow=user", "-c", "credential.helper=", "-c", "core.askPass=",
            "-c", "color.ui=false", "-c", "core.quotepath=false"]


class GitService:
    def __init__(self, ws, ApiError):
        self.ws = ws
        self.E = ApiError

    # ------------------------------------------------------------- plumbing
    def _env(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("OC_DAEMON") and not k.startswith("GIT_")}
        env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C.UTF-8",
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_ASKPASS": "true", "SSH_ASKPASS": "true"})
        return env

    def _git(self, cwd, args, timeout=LOCAL_TIMEOUT, ident=False, env_extra=None):
        pre = list(SAFE_CFG)
        if ident:    # only used for commits/stash: supply an identity when the user has none configured
            pre += ["-c", "user.name=" + (self._cfg(cwd, "user.name") or "OpenCode SI"),
                    "-c", "user.email=" + (self._cfg(cwd, "user.email") or "opencode-si@localhost")]
        env = self._env()
        if env_extra:
            env.update(env_extra)
        t0 = time.time()
        try:
            r = subprocess.run(["git"] + pre + list(args), cwd=cwd, env=env, capture_output=True,
                               stdin=subprocess.DEVNULL, timeout=timeout)
        except FileNotFoundError:
            raise self.E("GIT_MISSING", "Git is not installed (pkg install git).", 424)
        except subprocess.TimeoutExpired:
            raise self.E("GIT_TIMEOUT", "Git did not finish within %d s." % timeout, 504)
        out = r.stdout[:OUT_CAP].decode("utf-8", "replace")
        err = r.stderr[:OUT_CAP].decode("utf-8", "replace")
        return {"code": r.returncode, "stdout": out, "stderr": err, "truncated": len(r.stdout) > OUT_CAP,
                "duration_ms": int((time.time() - t0) * 1000)}

    def _cfg(self, cwd, key):
        try:
            r = subprocess.run(["git", "config", "--get", key], cwd=cwd, env=self._env(), capture_output=True,
                               stdin=subprocess.DEVNULL, timeout=5)
            return r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""

    def _ok(self, res, what):
        if res["code"] != 0:
            msg = (res["stderr"] or res["stdout"]).strip().splitlines()
            raise self.E("GIT_FAILED", "git %s failed: %s" % (what, msg[0] if msg else "exit %d" % res["code"]),
                         422, (res["stderr"] or res["stdout"])[-2000:])
        return res

    def _root(self, a, need_repo=True):
        root = self.ws.project_dir(a.get("project"))
        if need_repo and not os.path.isdir(os.path.join(root, ".git")) and not os.path.isfile(os.path.join(root, ".git")):
            raise self.E("NOT_A_REPO", "This project is not a Git repository yet. Run git init first.", 409)
        return root

    def _ref(self, v, what="ref"):
        if not isinstance(v, str) or not REF_RE.match(v) or ".." in v or v.endswith("/") or v.endswith(".lock"):
            raise self.E("INVALID_ARGUMENT", "Invalid %s." % what, 400)
        return v

    def _remote(self, v):
        if not isinstance(v, str) or not REMOTE_RE.match(v):
            raise self.E("INVALID_ARGUMENT", "Invalid remote name.", 400)
        return v

    def _paths(self, a, key="paths"):
        raw = a.get(key)
        if raw is None and a.get("path") is not None:
            raw = [a.get("path")]
        if not isinstance(raw, list) or len(raw) > 500:
            raise self.E("INVALID_ARGUMENT", "%s must be a list of project paths." % key, 400)
        out = []
        for p in raw:
            _, full, rel = self.ws.resolve(a.get("project"), p)
            out.append(rel or ".")
        return out

    # ------------------------------------------------------------- operations
    def init(self, a):
        root = self._root(a, need_repo=False)
        if os.path.exists(os.path.join(root, ".git")):
            raise self.E("ALREADY_EXISTS", "This project is already a Git repository.", 409)
        self._ok(self._git(root, ["init", "-b", "main"]), "init")
        return {"initialised": True}

    def status(self, a):
        root = self._root(a)
        r = self._ok(self._git(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]), "status")
        parts = r["stdout"].split("\0")
        branch, ahead, behind, upstream, files = "", 0, 0, None, []
        i = 0
        while i < len(parts):
            e = parts[i]
            i += 1
            if not e:
                continue
            if e.startswith("## "):
                head = e[3:]
                m = re.match(r"^(?:No commits yet on |Initial commit on )?([^ .]+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$", head)
                if m:
                    branch, upstream = m.group(1), m.group(2)
                    for part in (m.group(3) or "").split(","):
                        part = part.strip()
                        if part.startswith("ahead "):
                            ahead = int(part[6:])
                        elif part.startswith("behind "):
                            behind = int(part[7:])
                continue
            x, y, path = e[0], e[1], e[3:]
            if x in "RC":      # rename/copy: next NUL field is the original path
                i += 1
            code = "?" if (x, y) == ("?", "?") else (x if x not in " ?" else y)
            files.append({"path": path, "code": code, "index": x.strip(), "worktree": y.strip(),
                          "staged": x not in " ?", "untracked": (x, y) == ("?", "?")})
        if not branch or branch == "HEAD":
            rp = self._git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
            if rp["code"] == 0:
                branch = rp["stdout"].strip()
        return {"branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind, "files": files,
                "clean": not files}

    def diff(self, a):
        root = self._root(a)
        args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"]
        if a.get("staged"):
            args.append("--cached")
        if a.get("path"):
            _, _, rel = self.ws.resolve(a.get("project"), a["path"])
            args += ["--", rel]
        r = self._ok(self._git(root, args), "diff")
        text = r["stdout"]
        if a.get("path") and not text.strip() and not a.get("staged"):     # untracked file: diff against nothing
            _, full, rel = self.ws.resolve(a.get("project"), a["path"])
            if os.path.isfile(full):
                u = self._git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", os.devnull, rel])
                if u["code"] in (0, 1):
                    text = u["stdout"]
        return {"text": text, "truncated": r["truncated"]}

    def log(self, a):
        root = self._root(a)
        n = max(1, min(int(a.get("limit", 20)), 200))
        r = self._git(root, ["log", "-%d" % n, "--pretty=format:%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1e"])
        if r["code"] != 0:
            if "does not have any commits" in r["stderr"]:
                return []
            self._ok(r, "log")
        out = []
        for rec in r["stdout"].split("\x1e"):
            f = rec.strip("\n").split("\x1f")
            if len(f) == 5:
                out.append({"full": f[0], "hash": f[1], "author": f[2], "at": int(f[3]) * 1000, "msg": f[4]})
        return out

    def branch(self, a):
        root = self._root(a)
        action = a.get("action", "list")
        if action == "list":
            r = self._ok(self._git(root, ["branch", "--list", "--format=%(HEAD)|%(refname:short)"]), "branch")
            br = []
            for line in r["stdout"].splitlines():
                if "|" in line:
                    h, n = line.split("|", 1)
                    br.append({"name": n, "current": h == "*"})
            return {"branches": br}
        name = self._ref(a.get("name"), "branch name")
        if action == "create":
            self._ok(self._git(root, ["branch", name] + ([self._ref(a["start"], "start point")] if a.get("start") else [])), "branch")
        elif action == "delete":
            self._ok(self._git(root, ["branch", "-D" if a.get("force") else "-d", name]), "branch -d")
        elif action == "rename":
            self._ok(self._git(root, ["branch", "-m", name, self._ref(a.get("new_name"), "new branch name")]), "branch -m")
        else:
            raise self.E("INVALID_ARGUMENT", "Unknown branch action.", 400)
        return {"action": action, "name": name}

    def checkout(self, a):
        root = self._root(a)
        if a.get("paths") or a.get("path"):
            raise self.E("INVALID_ARGUMENT", "Use restore to discard file changes.", 400)
        ref = self._ref(a.get("ref"), "branch or commit")
        st = self.status(a)
        if st["files"] and not a.get("confirmed") and not a.get("create"):
            raise self.E("CONFIRMATION_REQUIRED", "You have uncommitted changes; switching may fail or carry them over.", 409,
                         [f["path"] for f in st["files"]][:20])
        args = ["checkout"] + (["-b"] if a.get("create") else []) + [ref, "--"]
        self._ok(self._git(root, args), "checkout")
        return {"ref": ref}

    def add(self, a):
        root = self._root(a)
        paths = ["."] if a.get("all") else self._paths(a)
        if not paths:
            raise self.E("INVALID_ARGUMENT", "Nothing to add.", 400)
        self._ok(self._git(root, ["add", "--"] + paths), "add")
        return {"added": paths}

    def restore(self, a):
        root = self._root(a)
        paths = self._paths(a)
        if not a.get("confirmed") and not a.get("staged"):
            raise self.E("CONFIRMATION_REQUIRED", "Restoring discards your uncommitted changes to these files.", 409, paths)
        args = ["restore"] + (["--staged"] if a.get("staged") else [])
        if a.get("source"):
            args += ["--source", self._ref(a["source"], "source")]
        self._ok(self._git(root, args + ["--"] + paths), "restore")
        return {"restored": paths}

    def commit(self, a):
        root = self._root(a)
        msg = a.get("message")
        if not isinstance(msg, str) or not msg.strip() or len(msg) > 5000 or "\0" in msg:
            raise self.E("INVALID_ARGUMENT", "A commit message is required.", 400)
        if a.get("all", True):
            self._ok(self._git(root, ["add", "-A"]), "add")
        r = self._git(root, ["commit", "--no-verify", "-m", msg.strip()], ident=True)
        if r["code"] != 0 and "nothing to commit" in (r["stdout"] + r["stderr"]):
            raise self.E("NOTHING_TO_COMMIT", "There are no changes to commit.", 409)
        self._ok(r, "commit")
        h = self._git(root, ["log", "-1", "--pretty=format:%h"])
        return {"hash": h["stdout"].strip(), "msg": msg.strip(), "at": int(time.time() * 1000)}

    def fetch(self, a):
        root = self._root(a)
        args = ["fetch"] + ([self._remote(a["remote"])] if a.get("remote") else ["--all"])
        r = self._ok(self._git(root, args, timeout=NET_TIMEOUT), "fetch")
        return {"output": (r["stdout"] + r["stderr"]).strip()}

    def pull(self, a):
        root = self._root(a)
        args = ["pull", "--no-edit", "--ff-only" if a.get("ff_only", True) else "--no-rebase"]
        if a.get("remote"):
            args.append(self._remote(a["remote"]))
            if a.get("branch"):
                args.append(self._ref(a["branch"], "branch"))
        r = self._ok(self._git(root, args, timeout=NET_TIMEOUT, ident=True), "pull")
        return {"output": (r["stdout"] + r["stderr"]).strip()}

    def push(self, a):
        root = self._root(a)
        force = bool(a.get("force"))
        if force and not a.get("confirmed"):
            raise self.E("CONFIRMATION_REQUIRED", "Force-pushing can overwrite other people's work.", 409)
        args = ["push"] + (["--force-with-lease"] if force else [])
        if a.get("set_upstream"):
            args.append("-u")
        if a.get("remote"):
            args.append(self._remote(a["remote"]))
            if a.get("branch"):
                args.append(self._ref(a["branch"], "branch"))
        r = self._ok(self._git(root, args, timeout=NET_TIMEOUT), "push")
        return {"output": (r["stdout"] + r["stderr"]).strip()}

    def stash(self, a):
        root = self._root(a)
        action = a.get("action", "list")
        if action == "list":
            r = self._ok(self._git(root, ["stash", "list", "--format=%gd|%s"]), "stash list")
            return {"stashes": [{"ref": l.split("|", 1)[0], "msg": l.split("|", 1)[1]} for l in r["stdout"].splitlines() if "|" in l]}
        if action == "push":
            args = ["stash", "push", "--include-untracked"] + (["-m", a["message"][:200]] if isinstance(a.get("message"), str) and a["message"] else [])
            r = self._ok(self._git(root, args, ident=True), "stash")
            return {"output": r["stdout"].strip()}
        ref = a.get("ref", "stash@{0}")
        if not re.match(r"^stash@\{\d{1,3}\}$", str(ref)):
            raise self.E("INVALID_ARGUMENT", "Invalid stash reference.", 400)
        if action in ("pop", "apply"):
            r = self._ok(self._git(root, ["stash", action, ref], ident=True), "stash " + action)
            return {"output": r["stdout"].strip()}
        if action == "drop":
            if not a.get("confirmed"):
                raise self.E("CONFIRMATION_REQUIRED", "Dropping a stash permanently deletes it.", 409)
            self._ok(self._git(root, ["stash", "drop", ref]), "stash drop")
            return {"dropped": ref}
        raise self.E("INVALID_ARGUMENT", "Unknown stash action.", 400)

    def rev_parse(self, a):
        root = self._root(a)
        args = a.get("args") or []
        if not isinstance(args, list) or not args or len(args) > 6:
            raise self.E("INVALID_ARGUMENT", "rev-parse needs 1-6 arguments.", 400)
        clean = []
        for x in args:
            if x in REV_FLAGS:
                clean.append(x)
            else:
                clean.append(self._ref(x, "revision"))
        r = self._ok(self._git(root, ["rev-parse"] + clean), "rev-parse")
        return {"output": r["stdout"].strip()}

    def clone(self, a):
        url = a.get("url")
        name = a.get("name")
        if not isinstance(url, str) or not URL_RE.match(url):
            raise self.E("INVALID_ARGUMENT", "Only https://, ssh:// or git@host:path URLs can be cloned.", 400)
        if not name:
            name = re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1].split(":")[-1])
        name = name.strip()
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$", name):
            raise self.E("INVALID_ARGUMENT", "Could not derive a valid project name; pass one.", 400)
        dest = os.path.join(self.ws.root, name)
        if os.path.exists(dest):
            raise self.E("ALREADY_EXISTS", "A project named \"%s\" already exists." % name, 409)
        r = self._git(self.ws.root, ["clone", "--no-hardlinks", "--", url, name], timeout=600)
        if r["code"] != 0:
            import shutil
            shutil.rmtree(dest, ignore_errors=True)
        self._ok(r, "clone")
        return {"id": name, "name": name, "updated": int(time.time() * 1000)}
