"""ocd_agent.py - real agent gateway (OpenAI-compatible chat/completions with tool calling).

What makes it "real":
  * the model can only act through five tools; each tool call is executed against the actual project
    (FS service / a real process) and the RESULT - success or the real error - is fed back to the model;
  * the daemon keeps its own action log. The summary shown to the user ("Created X", "Ran npm test: exit 1")
    is generated from that log, never from the model's prose, so it cannot claim something that did not happen;
  * before the first write/delete/command of a run a snapshot is taken, so the whole run can be rolled back;
  * run_command is subject to the same Policy as the terminal: denied commands fail, "confirm" commands are
    refused with a message that the user must run them themselves (no silent bypass).

Secrets: the provider api_key arrives per request from the Android SecureStore over loopback+bearer auth,
lives only in memory for the duration of a run, and is scrubbed from every error/log string. It is never written
to disk (session files store messages only).
"""
import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_STEPS = 30
MAX_TOOL_OUT = 20000
MAX_CHANGE_BYTES = 200000
HTTP_TIMEOUT = 120
MAX_HISTORY_CHARS = 300000

TOOLS = [
    {"type": "function", "function": {"name": "list_files", "description": "List files and folders in a project directory.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "Project-relative folder, '' for the root"}}, "required": []}}},
    {"type": "function", "function": {"name": "read_file", "description": "Read a UTF-8 text file from the project.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "search", "description": "Search file names and file contents (case-insensitive substring).",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a text file with the COMPLETE new content.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "run_command", "description": "Run a shell command in the project directory (60s default timeout). Returns exit code, stdout and stderr.",
     "parameters": {"type": "object", "properties": {"command": {"type": "string"}, "timeout_seconds": {"type": "integer"}}, "required": ["command"]}}},
]

SYSTEM = """You are OpenCode SI, a coding agent working inside the user's project "{project}" on an Android phone (Termux).
Project types detected: {types}.
Rules:
- You can ONLY act through the provided tools. Paths are relative to the project root.
- Read files before editing them. write_file replaces the whole file, so always send the complete content.
- After changing code, verify it with run_command (tests, build, or a syntax check) when a command exists.
- Tool results are the truth. If a tool returns an error, say so and try another approach or explain; never claim success you did not observe.
- Be concise. When finished, summarise what you did and anything that still needs the user's attention."""


class AgentError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def validate_base_url(url, E):
    try:
        u = urllib.parse.urlparse(url)
    except ValueError:
        raise E("INVALID_ARGUMENT", "Invalid provider URL.", 400)
    if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password:
        raise E("INVALID_ARGUMENT", "Provider URL must be http(s)://host[:port]/path without credentials.", 400)
    try:
        ip = ipaddress.ip_address(u.hostname)
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            raise E("INVALID_ARGUMENT", "That provider address is not allowed.", 400)
    except ValueError:
        pass
    if u.scheme == "http":
        host = u.hostname
        private = host == "localhost" or host.endswith(".local")
        try:
            ip = ipaddress.ip_address(host)
            private = private or ip.is_loopback or ip.is_private
        except ValueError:
            pass
        if not private:
            raise E("INVALID_ARGUMENT", "Plain http:// is only allowed for localhost / LAN servers. Use https:// for hosted APIs.", 400)
    return url.rstrip("/")


class LLM:
    def __init__(self, cfg, E):
        self.E = E
        self.base = validate_base_url(cfg.get("base_url") or "", E)
        self.model = cfg.get("model") or ""
        self.key = cfg.get("api_key") or ""
        if not isinstance(self.model, str) or not re.match(r"^[A-Za-z0-9._:/@+-]{1,200}$", self.model):
            raise E("PROVIDER_NOT_CONFIGURED", "No model is configured for this provider.", 400)

    def scrub(self, s):
        s = str(s)
        return s.replace(self.key, "***") if self.key else s

    def _req(self, method, path, body=None, timeout=HTTP_TIMEOUT):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "opencode-si/0.2")
        if self.key:
            req.add_header("Authorization", "Bearer " + self.key)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read(8 * 1024 * 1024)
            return json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(2000).decode("utf-8", "replace")
            except Exception:
                pass
            detail = self.scrub(detail)
            if e.code in (401, 403):
                raise AgentError("PROVIDER_AUTH", "The provider rejected the API key (HTTP %d)." % e.code, detail)
            if e.code == 429:
                raise AgentError("PROVIDER_RATE_LIMIT", "The provider is rate limiting requests (HTTP 429).", detail)
            if e.code == 404:
                raise AgentError("PROVIDER_NOT_FOUND", "Endpoint or model not found (HTTP 404). Check the base URL and model name.", detail)
            raise AgentError("PROVIDER_ERROR", "The provider returned HTTP %d." % e.code, detail)
        except urllib.error.URLError as e:
            raise AgentError("PROVIDER_UNREACHABLE", "Could not reach the provider.", self.scrub(getattr(e, "reason", e)))
        except (TimeoutError, OSError) as e:
            raise AgentError("PROVIDER_TIMEOUT", "The provider did not answer in time.", self.scrub(e))
        except ValueError:
            raise AgentError("PROVIDER_BAD_RESPONSE", "The provider returned something that is not JSON.")

    def models(self):
        r = self._req("GET", "/models", timeout=20)
        items = r.get("data") if isinstance(r, dict) else None
        if not isinstance(items, list):
            raise AgentError("PROVIDER_BAD_RESPONSE", "The provider did not return a model list.")
        out = []
        for m in items[:500]:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                out.append({"id": m["id"], "name": m.get("name") or m["id"]})
        return out

    def chat(self, messages):
        r = self._req("POST", "/chat/completions", {"model": self.model, "messages": messages, "tools": TOOLS,
                                                        "tool_choice": "auto", "temperature": 0.2})
        try:
            msg = r["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise AgentError("PROVIDER_BAD_RESPONSE", "The provider response had no message.", self.scrub(json.dumps(r)[:500]))
        return msg, r.get("usage")


class AgentSession:
    def __init__(self, sid, project):
        self.id, self.project = sid, project
        self.messages = []            # LLM transcript (no system prompt; added per call)
        self.steps = []               # real action log
        self.changes = {}             # path -> {"old": str|None, "new": str|None}
        self.state = "IDLE"           # IDLE | RUNNING | DONE | FAILED | CANCELLED
        self.reply = ""
        self.error = None
        self.task = None
        self.snapshot = None
        self.cancel_ev = threading.Event()
        self.thread = None
        self.lock = threading.RLock()
        self.created = time.time()
        self.updated = time.time()
        self.provider = None          # in-memory only
        self.usage = {"prompt": 0, "completion": 0}


class AgentService:
    def __init__(self, daemon, fs, snap, detect, E):
        self.d, self.fs, self.snap, self.detect, self.E = daemon, fs, snap, detect, E
        self.sessions = {}
        self.lock = threading.RLock()
        self.dir = os.path.join(daemon.ws.root, ".oc-agent")
        os.makedirs(self.dir, mode=0o700, exist_ok=True)

    # ------------------------------------------------------------ persistence (no secrets)
    def _path(self, sid):
        return os.path.join(self.dir, sid + ".json")

    def _save(self, s):
        data = {"id": s.id, "project": s.project, "messages": s.messages, "steps": s.steps, "changes": s.changes,
                "state": s.state, "reply": s.reply, "error": s.error, "task": s.task, "snapshot": s.snapshot,
                "created": s.created, "updated": s.updated}
        tmp = self._path(s.id) + ".tmp"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
            os.replace(tmp, self._path(s.id))
        except OSError:
            pass

    def _load(self, sid):
        try:
            with open(self._path(sid)) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None
        s = AgentSession(d["id"], d["project"])
        for k in ("messages", "steps", "changes", "state", "reply", "error", "task", "snapshot", "created", "updated"):
            if k in d:
                setattr(s, k, d[k])
        if s.state == "RUNNING":        # the daemon died mid-run: it is resumable, not running
            s.state = "INTERRUPTED"
        return s

    def get(self, sid):
        if not isinstance(sid, str) or not re.match(r"^a[0-9a-f]{10}$", sid):
            raise self.E("INVALID_ARGUMENT", "Invalid session id.", 400)
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                s = self._load(sid)
                if not s:
                    raise self.E("NOT_FOUND", "No such agent session.", 404)
                self.sessions[sid] = s
            return s

    # ------------------------------------------------------------ API
    def start(self, a):
        project = a.get("project")
        self.d.ws.project_dir(project)
        sid = "a" + uuid.uuid4().hex[:10]
        s = AgentSession(sid, project)
        with self.lock:
            self.sessions[sid] = s
        self._save(s)
        return {"sessionId": sid, "project": project, "tools": [t["function"]["name"] for t in TOOLS]}

    def _provider(self, a):
        p = a.get("provider")
        if not isinstance(p, dict):
            raise self.E("PROVIDER_NOT_CONFIGURED", "No provider configuration was supplied.", 400)
        if not p.get("base_url"):
            raise self.E("PROVIDER_NOT_CONFIGURED", "This provider has no base URL yet. Set it in Settings.", 400)
        if p.get("needs_key", True) and not p.get("api_key"):
            raise self.E("PROVIDER_NO_KEY", "No API key saved for this provider.", 400)
        return p

    def send(self, a):
        s = self.get(a.get("session_id"))
        msg = a.get("message")
        if not isinstance(msg, str) or not msg.strip() or len(msg) > 20000:
            raise self.E("INVALID_ARGUMENT", "A message (max 20000 chars) is required.", 400)
        llm = LLM(self._provider(a), self.E)            # validates URL/model before anything starts
        with s.lock:
            if s.state == "RUNNING":
                raise self.E("BUSY", "The agent is still working on the previous message.", 409)
            s.messages.append({"role": "user", "content": msg.strip()})
            s.task = msg.strip()[:300]
            s.steps, s.changes, s.reply, s.error = [], {}, "", None
            s.snapshot = None
            return self._launch(s, llm)

    def resume(self, a):
        s = self.get(a.get("session_id"))
        llm = LLM(self._provider(a), self.E)
        with s.lock:
            if s.state == "RUNNING":
                raise self.E("BUSY", "The agent is already running.", 409)
            if s.state not in ("CANCELLED", "INTERRUPTED", "FAILED"):
                raise self.E("NOT_RESUMABLE", "Nothing to resume (state %s)." % s.state, 409)
            s.error = None
            return self._launch(s, llm)

    def _launch(self, s, llm):
        s.cancel_ev.clear()
        s.state = "RUNNING"
        s.updated = time.time()
        s.thread = threading.Thread(target=self._run, args=(s, llm), daemon=True, name="agent-" + s.id)
        s.thread.start()
        return self.status({"session_id": s.id})

    def cancel(self, a):
        s = self.get(a.get("session_id"))
        s.cancel_ev.set()
        return {"cancelled": s.state == "RUNNING", "state": s.state}

    def status(self, a):
        s = self.get(a.get("session_id"))
        since = int(a.get("since", 0) or 0)
        with s.lock:
            ch = []
            for p, c in s.changes.items():
                ch.append({"path": p, "isNew": c["old"] is None, "deleted": c["new"] is None, "old": c["old"], "newContent": c["new"],
                           "truncated": bool(c.get("truncated"))})
            return {"sessionId": s.id, "project": s.project, "state": s.state, "task": s.task, "reply": s.reply,
                    "error": s.error, "steps": s.steps[since:], "stepCount": len(s.steps), "changes": ch,
                    "snapshot": s.snapshot, "usage": s.usage, "summary": self._summary(s)}

    def models(self, a):
        return self._models(a)

    def _models(self, a):
        p = a.get("provider") or {}
        if not p.get("base_url"):
            raise self.E("PROVIDER_NOT_CONFIGURED", "This provider has no base URL yet.", 400)
        cfg = dict(p)
        cfg.setdefault("model", "probe")
        if not cfg.get("model"):
            cfg["model"] = "probe"
        llm = LLM(cfg, self.E)
        try:
            return llm.models()
        except AgentError as e:
            raise self.E(e.code, e.message, 502, e.details)

    def probe(self, a):
        """Provider health: a real authenticated GET /models. Never returns the key."""
        p = a.get("provider") or {}
        if not p.get("base_url"):
            return {"status": "warning", "detail": "No base URL configured", "raw": "PROVIDER_NOT_CONFIGURED"}
        if p.get("needs_key", True) and not p.get("api_key"):
            return {"status": "warning", "detail": "No API key saved", "raw": "PROVIDER_NO_KEY"}
        cfg = dict(p)
        cfg["model"] = cfg.get("model") or "probe"
        t0 = time.time()
        try:
            models = LLM(cfg, self.E).models()
        except AgentError as e:
            return {"status": "failed", "detail": e.message, "raw": e.code + (": " + str(e.details)[:300] if e.details else "")}
        wanted = p.get("model")
        note = ""
        if wanted and models and wanted not in [m["id"] for m in models]:
            return {"status": "warning", "detail": "Reachable, but model \"%s\" is not in the provider's list" % wanted,
                    "raw": "MODEL_NOT_LISTED", "models": len(models), "latency_ms": int((time.time() - t0) * 1000)}
        return {"status": "ok", "detail": "Reachable, %d model(s)%s" % (len(models), note), "models": len(models),
                "latency_ms": int((time.time() - t0) * 1000)}

    # ------------------------------------------------------------ loop
    def _summary(self, s):
        """Generated from the real action log only."""
        lines = []
        for st in s.steps:
            if st["tool"] == "write_file":
                lines.append(("%s %s" % ("Created" if st.get("created") else "Updated", st["arg"])) if st["ok"] else "FAILED to write %s: %s" % (st["arg"], st.get("error")))
            elif st["tool"] == "run_command":
                lines.append(("Ran `%s` -> %s (exit %s)" % (st["arg"], st.get("status"), st.get("exit_code"))) if st["ok"] else "FAILED to run `%s`: %s" % (st["arg"], st.get("error")))
        return lines

    def _trim(self, s):
        total = sum(len(json.dumps(m)) for m in s.messages)
        if total <= MAX_HISTORY_CHARS:
            return
        for m in s.messages:
            if m.get("role") == "tool" and len(m.get("content", "")) > 1500:
                m["content"] = m["content"][:1500] + "\n...[older tool output trimmed]"
                total = sum(len(json.dumps(x)) for x in s.messages)
                if total <= MAX_HISTORY_CHARS:
                    return

    def _run(self, s, llm):
        try:
            types = ", ".join(self.detect(self.d.ws.project_dir(s.project))["types"]) or "unknown"
            system = {"role": "system", "content": SYSTEM.format(project=s.project, types=types)}
            for _ in range(MAX_STEPS):
                if s.cancel_ev.is_set():
                    return self._end(s, "CANCELLED", None)
                self._trim(s)
                msg, usage = llm.chat([system] + s.messages)
                if usage:
                    s.usage["prompt"] += int(usage.get("prompt_tokens") or 0)
                    s.usage["completion"] += int(usage.get("completion_tokens") or 0)
                calls = msg.get("tool_calls") or []
                entry = {"role": "assistant", "content": msg.get("content") or ""}
                if calls:
                    entry["tool_calls"] = [{"id": c.get("id") or "call_" + uuid.uuid4().hex[:8], "type": "function",
                                            "function": {"name": c["function"]["name"], "arguments": c["function"].get("arguments") or "{}"}} for c in calls]
                s.messages.append(entry)
                if not calls:
                    s.reply = entry["content"]
                    return self._end(s, "DONE", None)
                for c in entry["tool_calls"]:
                    if s.cancel_ev.is_set():
                        s.messages.append({"role": "tool", "tool_call_id": c["id"], "content": "Cancelled by the user."})
                        continue
                    out = self._tool(s, c["function"]["name"], c["function"]["arguments"])
                    s.messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})
                self._save(s)
            s.reply = "Stopped after %d tool rounds without finishing." % MAX_STEPS
            self._end(s, "FAILED", {"code": "STEP_LIMIT", "message": s.reply})
        except AgentError as e:
            self._end(s, "FAILED", {"code": e.code, "message": e.message, "details": e.details})
        except Exception as e:       # never leak internals
            self._end(s, "FAILED", {"code": "AGENT_INTERNAL", "message": "The agent stopped unexpectedly.", "details": type(e).__name__})

    def _end(self, s, state, err):
        with s.lock:
            # a cancelled run may have left an assistant tool_call without results; keep transcript valid
            pend = {}
            for m in s.messages:
                for c in m.get("tool_calls") or []:
                    pend[c["id"]] = True
                if m.get("role") == "tool":
                    pend.pop(m.get("tool_call_id"), None)
            for cid in pend:
                s.messages.append({"role": "tool", "tool_call_id": cid, "content": "Not executed (run stopped)."})
            s.state, s.error, s.updated = state, err, time.time()
            self._save(s)

    def _ensure_snapshot(self, s):
        if s.snapshot is None:
            try:
                s.snapshot = self.snap.create({"project": s.project, "label": "Before agent: " + (s.task or "task")[:60], "kind": "agent"})["id"]
            except Exception as e:
                raise AgentError("SNAPSHOT_FAILED", "Could not take the safety snapshot, so the agent will not modify the project.", str(getattr(e, "message", type(e).__name__)))

    def _tool(self, s, name, raw_args):
        step = {"i": len(s.steps), "tool": name, "arg": "", "ok": False, "t": time.time()}
        s.steps.append(step)
        try:
            try:
                args = json.loads(raw_args) if raw_args else {}
                if not isinstance(args, dict):
                    raise ValueError
            except ValueError:
                raise self.E("INVALID_ARGUMENT", "Tool arguments were not a JSON object.", 400)
            P = s.project
            if name == "list_files":
                step["arg"] = args.get("path", "") or "."
                r = self.fs.list({"project": P, "path": args.get("path", "")})
                out = "\n".join(("%s/" if e["type"] == "dir" else "%s") % e["path"] for e in r["entries"]) or "(empty)"
            elif name == "read_file":
                step["arg"] = str(args.get("path", ""))
                r = self.fs.read({"project": P, "path": args.get("path"), "limit": 200000})
                if r.get("binary"):
                    raise self.E("BINARY_FILE", "That is a binary file.", 400)
                out = r["content"] + ("\n...[truncated, file has %d bytes]" % r["size"] if r.get("truncated") else "")
            elif name == "search":
                step["arg"] = str(args.get("query", ""))
                r = self.fs.search({"project": P, "query": args.get("query"), "max_results": 40})
                out = "\n".join("%s:%s: %s" % (x["path"], x["line"], x["text"]) for x in r["results"]) or "(no matches)"
            elif name == "write_file":
                step["arg"] = str(args.get("path", ""))
                if not isinstance(args.get("content"), str):
                    raise self.E("INVALID_ARGUMENT", "content must be a string.", 400)
                self._ensure_snapshot(s)
                old = None
                try:
                    o = self.fs.read({"project": P, "path": args.get("path"), "limit": MAX_CHANGE_BYTES})
                    if o.get("binary"):
                        raise self.E("BINARY_FILE", "Refusing to overwrite a binary file.", 400)
                    old = o["content"] if not o.get("truncated") else None
                    if o.get("truncated"):
                        raise self.E("FILE_TOO_LARGE", "File is too large for the agent to overwrite safely.", 400)
                except self.E as e:
                    if e.code != "NOT_FOUND":
                        raise
                w = self.fs.write({"project": P, "path": args.get("path"), "content": args["content"]})
                step["created"] = w["created"]
                prev = s.changes.get(w["path"])
                s.changes[w["path"]] = {"old": prev["old"] if prev else old, "new": args["content"][:MAX_CHANGE_BYTES],
                                        "truncated": len(args["content"]) > MAX_CHANGE_BYTES}
                out = "OK: wrote %d bytes to %s" % (w["size"], w["path"])
            elif name == "run_command":
                cmd = args.get("command")
                step["arg"] = str(cmd)[:300]
                if not isinstance(cmd, str) or not cmd.strip():
                    raise self.E("INVALID_ARGUMENT", "command is required.", 400)
                self._ensure_snapshot(s)
                t = max(1, min(int(args.get("timeout_seconds") or 60), 600))
                r = self.d.run_job_sync(P, cmd, t * 1000, s.cancel_ev, source="agent")
                step.update({"status": r["status"], "exit_code": r["exit_code"]})
                out = "exit_code=%s status=%s\n--- stdout ---\n%s\n--- stderr ---\n%s" % (r["exit_code"], r["status"], r["stdout"], r["stderr"])
            else:
                raise self.E("UNKNOWN_TOOL", "Unknown tool: %s" % name, 400)
            step["ok"] = True
            step["bytes"] = len(out)
            return out[:MAX_TOOL_OUT] + ("\n...[output truncated]" if len(out) > MAX_TOOL_OUT else "")
        except self.E as e:
            step["error"] = "%s: %s" % (e.code, e.message)
            return "ERROR %s: %s" % (e.code, e.message)
        except AgentError:
            raise
        finally:
            step["done"] = time.time()
