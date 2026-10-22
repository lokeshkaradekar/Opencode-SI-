"""ocd_detect.py - detect project types from files that actually exist (no guessing).

Evidence for every detected type is returned so the UI/agent can show *why*.
Types: git, node, npm/pnpm/yarn, react, vite, next, typescript, python, javascript.
"""
import glob
import json
import os
import re

MAX_JSON = 1024 * 1024


def _read_json(path):
    try:
        if os.path.getsize(path) > MAX_JSON:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def _exists(root, name):
    p = os.path.join(root, name)
    return os.path.isfile(p) and not os.path.islink(p)


def _glob(root, pattern):
    return [os.path.basename(p) for p in glob.glob(os.path.join(glob.escape(root), pattern)) if os.path.isfile(p)]


def detect(root):
    types, evidence = [], {}

    def add(t, why):
        if t not in types:
            types.append(t)
        evidence.setdefault(t, []).append(why)

    scripts, pm = {}, None
    if os.path.exists(os.path.join(root, ".git")):
        add("git", ".git present")
    pkg = _read_json(os.path.join(root, "package.json")) if _exists(root, "package.json") else None
    if _exists(root, "package.json") and pkg is None:
        add("node", "package.json present but unreadable/invalid JSON")
        evidence["node"].append("WARNING: package.json is not valid JSON")
    if pkg is not None:
        add("node", "package.json")
        s = pkg.get("scripts")
        if isinstance(s, dict):
            scripts = {k: v for k, v in s.items() if isinstance(k, str) and isinstance(v, str)}
        deps = {}
        for k in ("dependencies", "devDependencies", "peerDependencies"):
            if isinstance(pkg.get(k), dict):
                deps.update(pkg[k])
        if "react" in deps:
            add("react", "react in package.json dependencies")
        if "vite" in deps:
            add("vite", "vite in package.json dependencies")
        if "next" in deps:
            add("next", "next in package.json dependencies")
        if "typescript" in deps:
            add("typescript", "typescript in package.json dependencies")
    for lock, name in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("package-lock.json", "npm"), ("bun.lockb", "bun")):
        if _exists(root, lock):
            pm = name
            add(name, lock)
            break
    if pkg is not None and pm is None:
        pm = "npm"
        add("npm", "package.json without another lockfile (npm default)")
    vc = _glob(root, "vite.config.*")
    if vc:
        add("vite", vc[0])
    if _exists(root, "tsconfig.json"):
        add("typescript", "tsconfig.json")
    nc = _glob(root, "next.config.*")
    if nc:
        add("next", nc[0])
    py_ev = [n for n in ("requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "setup.cfg") if _exists(root, n)]
    for n in py_ev:
        add("python", n)
    if not py_ev and glob.glob(os.path.join(glob.escape(root), "*.py")):
        add("python", "*.py files in project root")
    if pkg is None and glob.glob(os.path.join(glob.escape(root), "*.js")) + glob.glob(os.path.join(glob.escape(root), "*.mjs")):
        add("javascript", "*.js files in project root (no package.json)")
    elif pkg is not None:
        add("javascript", "package.json")
    if _exists(root, "Cargo.toml"):
        add("rust", "Cargo.toml")
    if _exists(root, "go.mod"):
        add("go", "go.mod")

    # primary type: most specific first
    primary = None
    for t in ("next", "vite", "react", "typescript", "node", "python", "javascript", "rust", "go", "git"):
        if t in types:
            primary = t
            break
    if "vite" in types and "react" in types:
        primary = "react-vite"

    run = (pm or "npm")
    suggest = {}
    if pkg is not None:
        suggest["install"] = {"pnpm": "pnpm install", "yarn": "yarn install", "bun": "bun install"}.get(run, "npm install")
        for k in ("dev", "start", "build", "test", "lint"):
            if k in scripts:
                suggest[k] = ("npm run %s" % k) if run == "npm" else ("%s %s" % (run, k))
        if "test" in scripts and run == "npm":
            suggest["test"] = "npm test"
    if "python" in types:
        if "requirements.txt" in py_ev:
            suggest.setdefault("install", "pip install -r requirements.txt")
        elif "pyproject.toml" in py_ev:
            suggest.setdefault("install", "pip install -e .")
        suggest.setdefault("test", "python -m unittest" if not _exists(root, "pytest.ini") else "python -m pytest")
    return {"types": types, "primary": primary, "package_manager": pm, "scripts": scripts, "suggested": suggest,
            "evidence": evidence, "empty": not types}
