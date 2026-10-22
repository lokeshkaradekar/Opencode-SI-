"""Workspace mapping and project path confinement."""
import json
import os
import re
from ocd_errors import ApiError

NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")

class Workspace:
    """Maps project names to directories. Local Termux implementation; a remote backend would
    implement the same methods against another host. Callers never see absolute paths as input."""

    def __init__(self, root):
        self.root = os.path.realpath(os.path.expanduser(root))
        os.makedirs(self.root, exist_ok=True)
        self._external_map_file = os.path.join(self.root, ".si-project-paths.json")
        self._opened_existing_file = os.path.join(self.root, ".si-opened-existing.json")
        self._opened_existing = set()
        try:
            with open(self._opened_existing_file, "r", encoding="utf-8") as f:
                names = json.load(f)
            if isinstance(names, list):
                self._opened_existing = {n for n in names if isinstance(n, str) and NAME_RE.match(n) and not n.startswith(".")}
        except (OSError, ValueError, TypeError):
            pass
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

    def _save_opened_existing(self):
        tmp = self._opened_existing_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(self._opened_existing), f, ensure_ascii=False)
        os.replace(tmp, self._opened_existing_file)

    def _validate_external_parent(self, value):
        if not isinstance(value, str) or "\0" in value:
            raise ApiError("INVALID_PATH", "Choose a valid project parent folder.", 400)
        parent = os.path.realpath(os.path.expanduser(value.strip()))
        home = os.path.realpath(os.path.expanduser("~"))
        shared = os.path.realpath("/storage/emulated/0")
        allowed_home = parent == home or parent.startswith(home + os.sep)
        allowed_shared = parent == shared or parent.startswith(shared + os.sep)
        # Android removable volumes are exposed under /storage/<volume-id>. Accept them only
        # when Termux can actually see the selected directory; SAF selection alone is not filesystem access.
        parts = parent.split(os.sep)
        allowed_volume = len(parts) >= 3 and parts[1] == "storage" and bool(re.match(r"^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$", parts[2]))
        if not (allowed_home or allowed_shared or allowed_volume) or os.path.islink(value):
            raise ApiError("INVALID_PATH", "Choose a folder in Termux home, shared phone storage, or an accessible mounted storage volume.", 400)
        accessible = os.path.isdir(parent) and os.access(parent, os.R_OK | os.W_OK | os.X_OK)
        if not accessible:
            if allowed_shared:
                raise ApiError("STORAGE_PERMISSION_REQUIRED",
                               "The Termux backend cannot read and write this phone-storage folder. In Termux, run termux-setup-storage, approve Android's storage permission, then fully restart Termux and retry. The Android folder picker alone does not grant filesystem access to Termux.",
                               403)
            if allowed_volume:
                raise ApiError("STORAGE_PERMISSION_REQUIRED",
                               "Termux cannot access this removable-storage folder. Android's folder picker alone does not grant filesystem access to Termux. Check whether this volume is mounted and writable by Termux; otherwise use a Termux-accessible copy of the project.",
                               403)
            raise ApiError("INVALID_PATH", "The selected folder does not exist or Termux cannot read and write it.", 400)
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


