"""Project-confined filesystem operations."""
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
from ocd_errors import ApiError, os_error
from ocd_workspace import NAME_RE, Workspace

MAX_READ_DEFAULT = 1024 * 1024
MAX_READ_HARD = 8 * 1024 * 1024
MAX_WRITE = 8 * 1024 * 1024

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

    def write_binary(self, a):
        import base64
        root, full, rel = self.ws.resolve(a.get("project"), a.get("path"))
        if not rel:
            raise ApiError("INVALID_PATH", "A file name is required.", 400)
        encoded = a.get("base64")
        if not isinstance(encoded, str):
            raise ApiError("INVALID_ARGUMENT", "base64 must be a string.", 400)
        if len(encoded) > ((MAX_WRITE + 2) // 3) * 4 + 8:
            raise ApiError("FILE_TOO_LARGE", "File is larger than 8 MB.", 413)
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception:
            raise ApiError("INVALID_ARGUMENT", "The selected file could not be decoded.", 400)
        if len(data) > MAX_WRITE:
            raise ApiError("FILE_TOO_LARGE", "File is larger than 8 MB.", 413)
        exists = os.path.lexists(full)
        if a.get("create_only", True) and exists:
            raise ApiError("ALREADY_EXISTS", "%s already exists. Rename the existing file before importing another copy." % rel, 409)
        if exists and os.path.isdir(full):
            raise ApiError("IS_DIRECTORY", "%s is a folder." % rel, 400)
        parent = os.path.dirname(full)
        try:
            os.makedirs(parent, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".oc-import-", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, full)
            except BaseException:
                try: os.unlink(tmp)
                except OSError: pass
                raise
        except OSError as e:
            raise os_error(e, "write")
        return {"path": rel, "size": len(data), "created": not exists}

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

    def open_existing_project(self, a):
        """Register an existing directory as a project without creating or nesting any folder."""
        name = (a.get("name") or "").strip()
        raw_path = a.get("path")
        if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith("."):
            raise ApiError("INVALID_ARGUMENT", "The selected folder has an invalid project name.", 400)
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ApiError("INVALID_PATH", "Select an existing project folder.", 400)
        path = self.ws._validate_external_parent(raw_path)
        home = os.path.realpath(os.path.expanduser("~"))
        shared = os.path.realpath("/storage/emulated/0")
        volume_root = bool(re.match(r"^/storage/[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$", path))
        if path in (home, shared) or volume_root:
            raise ApiError("INVALID_PATH", "Choose the project folder itself, not a storage or home root.", 400)
        if not os.path.isdir(path) or os.path.islink(raw_path):
            raise ApiError("INVALID_PATH", "The selected project folder is not an accessible real directory.", 400)
        current = self.ws._external_projects.get(name)
        local = os.path.join(self.ws.root, name)
        # A physical directory must have one project identity. Registering the same folder
        # under a second name makes project switching, terminal sessions and file edits appear
        # to target different projects even though they mutate the same files.
        for other_name, other_path in self.ws._external_projects.items():
            if other_name != name and os.path.realpath(other_path) == path:
                raise ApiError(
                    "PROJECT_PATH_ALREADY_OPEN",
                    "This folder is already open as project '%s'. Switch to that project instead of registering the same folder twice." % other_name,
                    409,
                )
        for other_name in os.listdir(self.ws.root):
            if other_name.startswith(".") or other_name == name or other_name in self.ws._external_projects:
                continue
            candidate = os.path.join(self.ws.root, other_name)
            if os.path.isdir(candidate) and os.path.realpath(candidate) == path:
                raise ApiError(
                    "PROJECT_PATH_ALREADY_OPEN",
                    "This folder is already available as project '%s'. Switch to that project instead of registering the same folder twice." % other_name,
                    409,
                )
        if current and os.path.realpath(current) == path:
            self.ws._opened_existing.add(name)
            self.ws._save_opened_existing()
            return {"id": name, "name": name, "path": path, "updated": int(os.stat(path).st_mtime * 1000), "git": os.path.isdir(os.path.join(path, ".git")), "openedExisting": True}
        if os.path.lexists(local) or (current and os.path.realpath(current) != path):
            raise ApiError("ALREADY_EXISTS", "A different project already uses this name. Rename that project or choose a folder with a different name.", 409)
        self.ws._external_projects[name] = path
        self.ws._opened_existing.add(name)
        self.ws._save_external_projects()
        self.ws._save_opened_existing()
        return {"id": name, "name": name, "path": path, "updated": int(os.stat(path).st_mtime * 1000), "git": os.path.isdir(os.path.join(path, ".git")), "openedExisting": True}

    def projects(self):
        out = []
        seen = set()
        for n in sorted(os.listdir(self.ws.root)):
            p = os.path.join(self.ws.root, n)
            if n.startswith(".") or n in self.ws._external_projects or not os.path.isdir(p) or not NAME_RE.match(n):
                continue
            seen.add(n)
            out.append({"id": n, "name": n, "path": os.path.realpath(p), "updated": int(os.stat(p).st_mtime * 1000), "git": os.path.isdir(os.path.join(p, ".git")), "openedExisting": False})
        for n, p in list(self.ws._external_projects.items()):
            if os.path.isdir(p):
                seen.add(n)
                out.append({"id": n, "name": n, "path": os.path.realpath(p), "updated": int(os.stat(p).st_mtime * 1000), "git": os.path.isdir(os.path.join(p, ".git")), "openedExisting": n in self.ws._opened_existing})
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
            return {"id": new, "name": new, "updated": int(os.stat(src).st_mtime * 1000), "path": os.path.realpath(src)}
        if external and old in self.ws._opened_existing:
            if new in self.ws._external_projects or os.path.lexists(os.path.join(self.ws.root, new)):
                raise ApiError("ALREADY_EXISTS", "A project with that name already exists.", 409)
            actual_path = self.ws._external_projects.pop(old)
            self.ws._external_projects[new] = actual_path
            self.ws._opened_existing.discard(old)
            self.ws._opened_existing.add(new)
            self.ws._save_external_projects()
            self.ws._save_opened_existing()
            return {"id": new, "name": new, "updated": int(os.stat(actual_path).st_mtime * 1000), "path": actual_path, "openedExisting": True}
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
        # Opening an existing folder is a non-owning registration. Removing it from SI must never
        # delete or move the user's original project files.
        if external and name in self.ws._opened_existing:
            self.ws._opened_existing.discard(name)
            self.ws._external_projects.pop(name, None)
            self.ws._save_external_projects()
            self.ws._save_opened_existing()
            return {"id": name, "deleted": True, "removedFromSi": True, "path": path}
        # Created external projects are still owned by SI and may be deleted explicitly.
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


