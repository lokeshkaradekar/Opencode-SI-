"""ocd_snap.py - real project snapshots / rollback.

Implementation (explicit, so it can be audited):
  * Each project gets a PRIVATE bare git directory at <workspace>/.oc-snapshots/<project>.git.
    It is separate from the project's own .git, so snapshots never touch the user's history, index or branches.
  * A snapshot is a commit of the whole working tree (GIT_DIR=private, GIT_WORK_TREE=project) stored under
    refs/snapshots/<id>. Metadata (label, time, good flag, file count) lives in the commit message.
  * node_modules, .venv, __pycache__, build outputs and any file > 5 MB are excluded (info/exclude).
    The project's own .git directory is never snapshotted.
  * Rollback: (1) a "before rollback" snapshot is taken automatically, (2) every file of the target snapshot is
    written back, (3) files that exist now but not in the target (and are not excluded) are removed. Both steps
    are confined to the project root (symlinks are never followed). Rollback needs confirmed=true.
"""
import os
import re
import shutil
import subprocess
import time
import uuid

EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", "dist/", "build/", ".gradle/", ".next/",
            ".cache/", "*.tmp", ".oc-*.tmp"]
MAX_FILE = 5 * 1024 * 1024
ID_RE = re.compile(r"^[0-9a-f]{40}$")


class SnapshotService:
    def __init__(self, ws, ApiError):
        self.ws = ws
        self.E = ApiError
        self.base = os.path.join(ws.root, ".oc-snapshots")
        os.makedirs(self.base, mode=0o700, exist_ok=True)

    def _gd(self, project):
        return os.path.join(self.base, project + ".git")

    def _run(self, project, args, env_extra=None, timeout=120, inp=None):
        root = self.ws.project_dir(project)
        gd = self._gd(project)
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and not k.startswith("OC_DAEMON")}
        env.update({"GIT_DIR": gd, "GIT_WORK_TREE": root, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_AUTHOR_NAME": "OpenCode SI", "GIT_AUTHOR_EMAIL": "snapshots@localhost",
                    "GIT_COMMITTER_NAME": "OpenCode SI", "GIT_COMMITTER_EMAIL": "snapshots@localhost"})
        if env_extra:
            env.update(env_extra)
        try:
            r = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
                                "-c", "core.quotepath=false", "-c", "core.symlinks=true"] + args,
                               cwd=root, env=env, capture_output=True, timeout=timeout, input=inp)
        except FileNotFoundError:
            raise self.E("GIT_MISSING", "Git is required for snapshots (pkg install git).", 424)
        except subprocess.TimeoutExpired:
            raise self.E("SNAPSHOT_TIMEOUT", "The snapshot operation took too long.", 504)
        return r

    def _init(self, project):
        gd = self._gd(project)
        if os.path.isdir(os.path.join(gd, "objects")):
            return
        os.makedirs(gd, mode=0o700, exist_ok=True)
        r = subprocess.run(["git", "init", "--bare", "-q", gd], capture_output=True, timeout=30)
        if r.returncode != 0:
            raise self.E("SNAPSHOT_FAILED", "Could not initialise snapshot storage.", 500, r.stderr.decode("utf-8", "replace")[-500:])
        os.makedirs(os.path.join(gd, "info"), exist_ok=True)
        with open(os.path.join(gd, "info", "exclude"), "w") as f:
            f.write("\n".join(EXCLUDES) + "\n")

    def _stage(self, project):
        """Stage the working tree into the private index. Returns the tree id."""
        root = self.ws.project_dir(project)
        r = self._run(project, ["add", "-A", "--", "."])
        if r.returncode != 0:
            raise self.E("SNAPSHOT_FAILED", "Could not read the project files.", 500, r.stderr.decode("utf-8", "replace")[-500:])
        # drop oversize files from the index so a stray big binary cannot bloat storage
        ls = self._run(project, ["ls-files", "-z"])
        big = []
        for rel in ls.stdout.decode("utf-8", "replace").split("\0"):
            if not rel:
                continue
            try:
                if os.lstat(os.path.join(root, rel)).st_size > MAX_FILE:
                    big.append(rel)
            except OSError:
                pass
        for i in range(0, len(big), 100):
            self._run(project, ["rm", "--cached", "-q", "--"] + big[i:i + 100])
        t = self._run(project, ["write-tree"])
        if t.returncode != 0:
            raise self.E("SNAPSHOT_FAILED", "Could not record the project state.", 500, t.stderr.decode("utf-8", "replace")[-500:])
        return t.stdout.decode().strip(), len(ls.stdout.split(b"\0")) - 1 - len(big), big

    # ---------------------------------------------------------------- API
    def create(self, a):
        project = a.get("project")
        self.ws.project_dir(project)
        label = a.get("label") or "Snapshot"
        if not isinstance(label, str) or len(label) > 120 or "\0" in label:
            raise self.E("INVALID_ARGUMENT", "Invalid label.", 400)
        label = " ".join(label.split())
        self._init(project)
        tree, nfiles, skipped = self._stage(project)
        now = int(time.time() * 1000)
        msg = "%s\n\noc-snapshot: 1\noc-label: %s\noc-at: %d\noc-good: %d\noc-files: %d\noc-kind: %s\n" % (
            label, label, now, 1 if a.get("good") else 0, nfiles, a.get("kind", "manual"))
        parent = self._run(project, ["rev-parse", "-q", "--verify", "refs/snapshots/latest"])
        args = ["commit-tree", tree, "-m", msg]
        if parent.returncode == 0:
            args += ["-p", parent.stdout.decode().strip()]
        c = self._run(project, args)
        if c.returncode != 0:
            raise self.E("SNAPSHOT_FAILED", "Could not save the snapshot.", 500, c.stderr.decode("utf-8", "replace")[-500:])
        sha = c.stdout.decode().strip()
        for ref in ("refs/snapshots/latest", "refs/snapshots/s-" + sha[:12]):
            u = self._run(project, ["update-ref", ref, sha])
            if u.returncode != 0:
                raise self.E("SNAPSHOT_FAILED", "Could not save the snapshot.", 500, u.stderr.decode("utf-8", "replace")[-500:])
        return {"id": sha, "short": sha[:12], "label": label, "at": now, "good": bool(a.get("good")), "files": nfiles,
                "skipped_large": skipped[:20]}

    def _meta(self, sha, body):
        meta = {"id": sha, "short": sha[:12]}
        for line in body.splitlines():
            if line.startswith("oc-label: "):
                meta["label"] = line[10:]
            elif line.startswith("oc-at: "):
                meta["at"] = int(line[7:])
            elif line.startswith("oc-good: "):
                meta["good"] = line[9:] == "1"
            elif line.startswith("oc-files: "):
                meta["files"] = int(line[10:])
            elif line.startswith("oc-kind: "):
                meta["kind"] = line[9:]
        meta.setdefault("label", "Snapshot")
        meta.setdefault("good", False)
        return meta

    def list(self, a):
        project = a.get("project")
        self.ws.project_dir(project)
        if not os.path.isdir(os.path.join(self._gd(project), "objects")):
            return []
        r = self._run(project, ["for-each-ref", "--format=%(objectname)", "refs/snapshots/"])
        shas, out = [], []
        for s in r.stdout.decode().split():
            if s not in shas:
                shas.append(s)
        for sha in shas:
            body = self._run(project, ["show", "-s", "--format=%B", sha]).stdout.decode("utf-8", "replace")
            if "oc-snapshot: 1" in body:
                out.append(self._meta(sha, body))
        out.sort(key=lambda m: m.get("at", 0), reverse=True)
        return out

    def _require(self, project, sid):
        if not isinstance(sid, str):
            raise self.E("INVALID_ARGUMENT", "Snapshot id is required.", 400)
        if not ID_RE.match(sid):                        # allow the 12-char short id the UI shows
            if re.match(r"^[0-9a-f]{12}$", sid):
                m = [x for x in self.list({"project": project}) if x["short"] == sid]
                if not m:
                    raise self.E("NOT_FOUND", "No such snapshot.", 404)
                return m[0]["id"]
            raise self.E("INVALID_ARGUMENT", "Invalid snapshot id.", 400)
        if self._run(project, ["cat-file", "-e", sid + "^{commit}"]).returncode != 0:
            raise self.E("NOT_FOUND", "No such snapshot.", 404)
        return sid

    def inspect(self, a):
        project = a.get("project")
        self.ws.project_dir(project)
        self._init(project)
        sid = self._require(project, a.get("id"))
        body = self._run(project, ["show", "-s", "--format=%B", sid]).stdout.decode("utf-8", "replace")
        meta = self._meta(sid, body)
        names = self._run(project, ["ls-tree", "-r", "--name-only", "-z", sid]).stdout.decode("utf-8", "replace").split("\0")
        files = [n for n in names if n]
        meta["file_list"] = files[:500]
        meta["file_list_truncated"] = len(files) > 500
        # what would change if restored now
        self._stage(project)
        cur = self._run(project, ["write-tree"]).stdout.decode().strip()
        d = self._run(project, ["diff-tree", "-r", "--name-status", "-z", cur, sid]).stdout.decode("utf-8", "replace").split("\0")
        changes, i = [], 0
        while i + 1 < len(d):
            changes.append({"status": d[i], "path": d[i + 1]})
            i += 2
        meta["would_change"] = changes[:200]
        meta["would_change_count"] = len(changes)
        return meta

    def rollback(self, a):
        project = a.get("project")
        root = self.ws.project_dir(project)
        self._init(project)
        sid = self._require(project, a.get("id"))
        if not a.get("confirmed"):
            info = self.inspect({"project": project, "id": sid})
            raise self.E("CONFIRMATION_REQUIRED",
                         "Rolling back changes %d file(s). A safety snapshot is taken first so this can be undone." % info["would_change_count"],
                         409, {"would_change": info["would_change"][:50]})
        safety = self.create({"project": project, "label": "Before rollback", "kind": "pre-rollback"})
        # files present now but absent in the target snapshot -> delete (excluded paths untouched)
        d = self._run(project, ["diff-tree", "-r", "--name-only", "--diff-filter=A", "-z", sid, safety["id"]])
        removed, errors = [], []
        for rel in [x for x in d.stdout.decode("utf-8", "replace").split("\0") if x]:
            p = os.path.join(root, rel)
            real_parent = os.path.realpath(os.path.dirname(p))
            if real_parent != root and not real_parent.startswith(root + os.sep):
                errors.append(rel)          # never touch anything outside the project
                continue
            try:
                os.unlink(p)
                removed.append(rel)
                d_ = os.path.dirname(p)
                while d_ != root and not os.listdir(d_):
                    os.rmdir(d_)
                    d_ = os.path.dirname(d_)
            except OSError:
                errors.append(rel)
        r = self._run(project, ["read-tree", sid])
        if r.returncode == 0:
            r = self._run(project, ["checkout-index", "-a", "-f"])
        if r.returncode != 0:
            raise self.E("ROLLBACK_FAILED", "Could not restore every file. Your previous state is saved as snapshot %s." % safety["short"],
                         500, r.stderr.decode("utf-8", "replace")[-1000:])
        return {"restored": sid, "short": sid[:12], "safety_snapshot": safety["id"], "removed": removed[:200],
                "removed_count": len(removed), "errors": errors[:50]}

    def delete(self, a):
        project = a.get("project")
        self.ws.project_dir(project)
        sid = self._require(project, a.get("id"))
        if not a.get("confirmed"):
            raise self.E("CONFIRMATION_REQUIRED", "Deleting a snapshot cannot be undone.", 409)
        refs = self._run(project, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/snapshots/"]).stdout.decode().splitlines()
        for ln in refs:
            ref, sha = ln.split(" ")
            if sha == sid and not ref.endswith("/latest"):
                self._run(project, ["update-ref", "-d", ref])
        return {"deleted": sid}

    def drop_project(self, project):
        shutil.rmtree(self._gd(project), ignore_errors=True)
