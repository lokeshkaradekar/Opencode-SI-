package com.opencode.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadFactory;
import java.util.regex.Pattern;

/**
 * Chat/agent operations on top of the official OpenCode server. The OpenCode agent does ALL the agent work (model call,
 * tool loop, file edits, commands). This class only: creates/continues sessions, starts a run on a worker thread,
 * reports what the server's own message log says, and decides - carefully - what a broken connection means.
 *
 * Long runs: sendMessage() blocks without a read timeout on its own thread, so the UI, the bridge pool and Activity
 * recreation are independent of it. The task registry lives in this process-wide object, not in the Activity.
 *
 * Never double-sends: after a transport error the session's message list is read back. The message is re-sent only if
 * the server demonstrably never received it. If it was received but its end was not observed the outcome is
 * reported as UNCERTAIN - never as success.
 */
final class OpenCodeAgent {
    interface Events {
        void emit(String name, JSONObject payload);
    }

    static final String S_RUNNING = "RUNNING", S_SUCCESS = "SUCCESS", S_FAILED = "FAILED", S_CANCELLED = "CANCELLED", S_UNCERTAIN = "UNCERTAIN";
    static final String K_MODEL = "oc.model";
    static final String K_SESSION = "oc.session.last";
    static final String K_LASTTASK = "oc.task.last";
    private static final Pattern MODEL_RE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$");

    static final class Task {
        final String sessionId;
        final String text;
        final long startedAt = System.currentTimeMillis();
        final int baseline;
        final String providerId;
        final String modelId;
        final String agentId;                            // "plan" | null (build = OpenCode's default agent)
        volatile String state = S_RUNNING;
        volatile JSONObject error;
        volatile String reply = "";
        volatile boolean cancelRequested;
        volatile int attempts;
        volatile long endedAt;
        volatile String snapshot;

        Task(String sessionId, String text, int baseline, String providerId, String modelId, String agentId) {
            this.sessionId = sessionId;
            this.text = text;
            this.baseline = baseline;
            this.providerId = providerId;
            this.modelId = modelId;
            this.agentId = agentId;
        }
    }

    private final OpenCodeServer server;
    private final OpenCodeServer.Host host;
    private final Map<String, Task> tasks = new ConcurrentHashMap<String, Task>();
    private volatile Events events;
    private final ThreadFactory threads = new ThreadFactory() {
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "opencode-task");
            t.setDaemon(true);
            return t;
        }
    };

    OpenCodeAgent(OpenCodeServer server, OpenCodeServer.Host host) {
        this.server = server;
        this.host = host;
    }

    void setEvents(Events e) {
        this.events = e;
    }

    Task task(String sessionId) {
        return tasks.get(sessionId);
    }

    // ------------------------------------------------------------- sessions
    private OpenCodeClient readyClient() throws NativeBridge.BridgeException {
        OpenCodeServer.Status st = server.status();
        if (st.ready()) {
            st = server.recheck();                       // a READY flag can be stale (Termux process killed): confirm with a real probe
        }
        if (!st.ready() || server.workspaceChanged()) {
            st = server.ensureReady(true, false);
        }
        if (!st.ready()) {
            throw new NativeBridge.BridgeException(st.code == null ? "OPENCODE_NOT_READY" : st.code, st.message, st.detail);
        }
        return server.client();
    }

    String startSession() throws NativeBridge.BridgeException {
        String id = readyClient().createSession();
        host.setPref(K_SESSION, id);
        return id;
    }

    JSONArray sessions() throws NativeBridge.BridgeException {
        JSONArray raw = readyClient().listSessions();
        JSONArray out = new JSONArray();
        for (int i = 0; i < raw.length() && i < 100; i++) {
            JSONObject s = raw.optJSONObject(i);
            if (s == null) {
                continue;
            }
            JSONObject time = s.optJSONObject("time");
            try {
                out.put(new JSONObject().put("id", s.optString("id")).put("title", s.optString("title", ""))
                        .put("updated", time == null ? 0 : time.optLong("updated", 0)).put("directory", s.optString("directory", "")));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // ----------------------------------------------------------------- send
    /** Starts a run and returns immediately. Progress/outcome via status() and the "opencode.task" event. */
    JSONObject send(String sessionId, String text) throws NativeBridge.BridgeException {
        return send(sessionId, text, null);
    }

    /**
     * Starts a run and returns immediately. agent="plan" asks the server to run this one message with its plan agent.
     * The app never claims to be read-only itself: it only passes the request on and reports what the server actually
     * does. When the server can list its agents (GET /agent), a missing "plan" is refused up front with
     * AGENT_UNAVAILABLE; when the list cannot be read the message is still sent and any real rejection from the
     * server is surfaced as-is. agent=null or "build" keeps OpenCode's default build agent exactly as before.
     */
    JSONObject send(String sessionId, String text, String agent) throws NativeBridge.BridgeException {
        if (agent != null && agent.length() > 0 && !"build".equals(agent) && !"plan".equals(agent)) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "Unknown mode. Choose Build or Plan.", null);
        }
        if (text == null || text.trim().length() == 0) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "The message is empty.", null);
        }
        if (text.length() > 200000) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "The message is too long.", null);
        }
        Task running = tasks.get(sessionId);
        if (running != null && S_RUNNING.equals(running.state)) {
            throw new NativeBridge.BridgeException("TASK_RUNNING", "This session is still working on the previous message.", null);
        }
        OpenCodeClient cl = readyClient();
        int baseline;
        try {
            baseline = cl.messages(sessionId).length();
        } catch (NativeBridge.BridgeException e) {
            if ("OPENCODE_UNSUPPORTED".equals(e.code) || "OPENCODE_REJECTED".equals(e.code)) {
                throw new NativeBridge.BridgeException("SESSION_NOT_FOUND", "OpenCode does not know this session any more. Start a new one.", e.details);
            }
            throw e;                                    // invalid id, server unreachable, auth...: nothing was sent
        }
        if ("plan".equals(agent)) {
            ensureAgent(cl, "plan");
        }
        String pid = null, mid = null;
        String model = host.pref(K_MODEL, "auto");
        if (model != null && !"auto".equals(model) && MODEL_RE.matcher(model).matches() && model.indexOf("..") < 0) {
            int slash = model.indexOf('/');
            pid = model.substring(0, slash);
            mid = model.substring(slash + 1);
        }
        /** agentId is sent to the server only for "plan": Build keeps the request body exactly as it is today (no override). */
        final Task t = new Task(sessionId, text, baseline, pid, mid, "plan".equals(agent) ? "plan" : null);
        synchronized (tasks) {
            Task again = tasks.get(sessionId);
            if (again != null && S_RUNNING.equals(again.state)) {
                throw new NativeBridge.BridgeException("TASK_RUNNING", "This session is still working on the previous message.", null);
            }
            tasks.put(sessionId, t);
        }
        server.taskCounter().incrementAndGet();
        host.setPref(K_SESSION, sessionId);
        persist(t);
        threads.newThread(new Runnable() {
            public void run() {
                try {
                    runTask(t);
                } finally {
                    server.taskCounter().decrementAndGet();
                    t.endedAt = System.currentTimeMillis();
                    persist(t);
                    fire(t);
                }
            }
        }).start();
        try {
            return new JSONObject().put("accepted", true).put("sessionId", sessionId).put("model", model == null ? "auto" : model);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private void runTask(Task t) {
        while (true) {
            t.attempts++;
            OpenCodeClient cl;
            try {
                cl = server.client();
            } catch (NativeBridge.BridgeException e) {
                finish(t, S_FAILED, e);
                return;
            }
            try {
                JSONObject resp = cl.sendMessage(t.sessionId, t.text, t.providerId, t.modelId, t.agentId);
                interpret(t, resp);
                return;
            } catch (NativeBridge.BridgeException e) {
                if (!isTransport(e.code)) {
                    finish(t, t.cancelRequested ? S_CANCELLED : S_FAILED, e);          // the server answered: this is its real error
                    return;
                }
                if (!resolveAfterTransportError(t, e)) {
                    return;                                                           // outcome recorded
                }
                // else: known NOT to have been accepted -> loop and send once more
            }
        }
    }

    private static boolean isTransport(String code) {
        return "OPENCODE_UNREACHABLE".equals(code) || "OPENCODE_CONNECTION_LOST".equals(code) || "OPENCODE_TIMEOUT".equals(code);
    }

    /**
     * Refuses Plan only when the server's own agent list is readable and provably lacks "plan". If the list cannot be
     * read (old version, protected route) the request is sent anyway and the server's real answer decides.
     */
    private void ensureAgent(OpenCodeClient cl, String wanted) throws NativeBridge.BridgeException {
        JSONArray list;
        try {
            list = cl.agents();
        } catch (NativeBridge.BridgeException e) {
            if ("OPENCODE_UNSUPPORTED".equals(e.code) || "OPENCODE_REJECTED".equals(e.code)) {
                return; // The route is unavailable, so the server's real message response decides capability.
            }
            throw e;                                   // real server/auth problems are real failures
        }
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a != null && wanted.equals(a.optString("id", ""))) {
                return;
            }
        }
        if ("plan".equals(wanted)) {
            if (!server.managedByApp()) throw new NativeBridge.BridgeException("AGENT_UNAVAILABLE", "The connected server does not expose a Plan agent and is not managed by OpenCode SI. Configure a Plan agent and restart that server in Termux.", null);
            // On the app-managed server, create a genuine primary Plan agent with edits denied and shell gated
            // by OpenCode's permission system, then restart/re-query before sending the user's message.
            try {
                server.ensurePlanAgent();
                OpenCodeClient refreshed = readyClient();
                JSONArray after = refreshed.agents();
                for (int i = 0; after != null && i < after.length(); i++) {
                    JSONObject a = after.optJSONObject(i);
                    if (a != null && wanted.equals(a.optString("id", ""))) return;
                }
            } catch (NativeBridge.BridgeException setup) {
                if ("PLAN_RESTART_REQUIRED".equals(setup.code)) throw new NativeBridge.BridgeException("AGENT_UNAVAILABLE", setup.getMessage(), setup.details);
                throw setup;
            }
        }
        throw new NativeBridge.BridgeException("AGENT_UNAVAILABLE",
                "This OpenCode server does not expose a usable \u201c" + wanted + "\u201d agent. The app attempted supported Plan-agent setup; check OpenCode diagnostics for details.", null);
    }

    /**
     * The connection broke while a run was in flight. Returns true ONLY when it is safe to send the message again
     * (the server is back and its log shows it never received this message, and we have not retried yet).
     */
    private boolean resolveAfterTransportError(Task t, NativeBridge.BridgeException cause) {
        server.note("transport error during task on " + t.sessionId + ": " + cause.code);
        OpenCodeServer.Status st = server.ensureReady(true, false);           // controlled recovery (restart if needed)
        if (!st.ready()) {
            finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("SERVER_LOST",
                    "The OpenCode server stopped and could not be restarted (" + st.message + "). The task may have run partly or not at all.", st.detail));
            return false;
        }
        if (t.baseline < 0) {
            finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("OUTCOME_UNKNOWN", "The connection broke and the session could not be inspected. The task may or may not have run.", null));
            return false;
        }
        JSONArray msgs;
        try {
            msgs = server.client().messages(t.sessionId);
        } catch (NativeBridge.BridgeException e) {
            finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("OUTCOME_UNKNOWN", "The connection broke and the session could not be inspected afterwards. The task may or may not have run.", e.code));
            return false;
        }
        boolean accepted = false;
        for (int i = Math.max(0, t.baseline); i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m != null && "user".equals(role(m)) && t.text.trim().equals(text(m).trim())) {
                accepted = true;
            }
        }
        if (!accepted) {
            if (t.attempts >= 2) {
                finish(t, S_FAILED, new NativeBridge.BridgeException("SEND_FAILED", "OpenCode did not receive the message after a retry.", cause.code));
                return false;
            }
            server.note("message was not received by the server: sending it once more");
            return true;
        }
        // The server has the message. If our connection merely dropped (app frozen/backgrounded) the run may still be going:
        // watch the server's own log for a bounded quiet period instead of guessing.
        long idleMs = server.idleWindowMs();
        // A long-running shell/tool call can legitimately produce no new message for minutes. Do not label
        // the whole task uncertain while the server still reports an active tool; use a generous hard bound
        // so a genuinely wedged server cannot hold the worker forever.
        long lastChange = System.currentTimeMillis();
        long recoveryStarted = lastChange;
        long maxRecoveryMs = 15L * 60L * 1000L;
        long activeToolQuietMs = Math.max(5000L, idleMs * 3L);
        String lastSig = null;
        while (System.currentTimeMillis() - recoveryStarted < maxRecoveryMs) {
            JSONObject d = describe(msgs, t.baseline);
            if (d.optJSONObject("error") != null) {
                JSONObject e = d.optJSONObject("error");
                finish(t, S_FAILED, new NativeBridge.BridgeException(e.optString("code", "AGENT_ERROR"), e.optString("message", "The agent reported an error."), e.optString("details", null)));
                return false;
            }
            if (d.optBoolean("completed", false)) {
                t.reply = d.optString("reply", "");
                t.state = t.cancelRequested ? S_CANCELLED : S_SUCCESS;
                return false;
            }
            JSONArray stepList = d.optJSONArray("steps");
            boolean activeTool = false;
            StringBuilder signature = new StringBuilder().append(d.optString("reply", "")).append('|');
            for (int i = 0; stepList != null && i < stepList.length(); i++) {
                JSONObject step = stepList.optJSONObject(i);
                if (step == null) continue;
                signature.append(step.optString("name", step.optString("tool", "tool"))).append(':')
                        .append(step.optString("arg", "")).append(':').append(step.optBoolean("done", false)).append(':')
                        .append(step.optBoolean("ok", false)).append('|');
                if (!step.optBoolean("done", false)) activeTool = true;
            }
            String sig = signature.toString();
            if (!sig.equals(lastSig)) {
                lastSig = sig;
                lastChange = System.currentTimeMillis();
            }
            // A running tool is direct evidence that work is still in flight. The idle timeout only applies
            // when the server has no unfinished tool activity.
            long quietFor = System.currentTimeMillis() - lastChange;
            if ((!activeTool && quietFor > idleMs) || (activeTool && quietFor > activeToolQuietMs)) break;
            try {
                Thread.sleep(2000);
                msgs = server.client().messages(t.sessionId);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            } catch (NativeBridge.BridgeException e2) {
                // Brief transport blips are retried within the hard recovery window.
                try { Thread.sleep(1000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
        finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("OUTCOME_UNKNOWN",
                "OpenCode received the message, but the connection broke and the run showed no further progress. It may have stopped part-way. Check the changes, then continue the session.", null));
        return false;
    }

    /** The blocking POST returned: read the server's own verdict (info.error) rather than assuming success. */
    private void interpret(Task t, JSONObject resp) {
        JSONObject info = resp.optJSONObject("info");
        JSONObject err = info == null ? null : info.optJSONObject("error");
        StringBuilder reply = new StringBuilder();
        JSONArray parts = resp.optJSONArray("parts");
        for (int i = 0; parts != null && i < parts.length(); i++) {
            JSONObject p = parts.optJSONObject(i);
            if (p != null && "text".equals(p.optString("type")) && !p.optBoolean("synthetic", false)) {
                if (reply.length() > 0) {
                    reply.append("\n");
                }
                reply.append(p.optString("text", ""));
            }
        }
        t.reply = reply.toString();
        if (err != null) {
            JSONObject data = err.optJSONObject("data");
            String name = err.optString("name", "AgentError");
            String msg = data == null ? "" : data.optString("message", "");
            if (msg.length() == 0) {
                msg = err.optString("message", name);
            }
            boolean aborted = name.toLowerCase(java.util.Locale.US).contains("abort");
            finish(t, aborted || t.cancelRequested ? S_CANCELLED : S_FAILED, new NativeBridge.BridgeException(codeFor(name), msg, name));
            return;
        }
        if (t.cancelRequested) {
            t.state = S_CANCELLED;
        } else {
            t.state = S_SUCCESS;
        }
    }

    private static String codeFor(String name) {
        String n = name.toLowerCase(java.util.Locale.US);
        if (n.contains("auth")) {
            return "PROVIDER_AUTH";
        }
        if (n.contains("model")) {
            return "MODEL_UNAVAILABLE";
        }
        if (n.contains("api") || n.contains("provider")) {
            return "PROVIDER_ERROR";
        }
        return "AGENT_ERROR";
    }

    private void finish(Task t, String state, NativeBridge.BridgeException e) {
        try {
            t.error = new JSONObject().put("code", e.code).put("message", e.getMessage()).put("details", e.details == null ? JSONObject.NULL : e.details);
        } catch (Exception ignored) {
        }
        t.state = state;
    }

    private void persist(Task t) {
        try {
            host.setPref(K_LASTTASK, new JSONObject().put("sessionId", t.sessionId).put("state", t.state).put("startedAt", t.startedAt).put("endedAt", t.endedAt).toString());
        } catch (Exception ignored) {
        }
    }

    private void fire(Task t) {
        Events ev = events;
        if (ev == null) {
            return;
        }
        try {
            ev.emit("opencode.task", new JSONObject().put("sessionId", t.sessionId).put("state", t.state));
        } catch (Exception ignored) {
        }
    }

    // --------------------------------------------------------------- status
    /** Shape consumed by agent.js: {state, steps[], reply, summary[], changes[], error}. Built from the server's real message log. */
    JSONObject status(String sessionId) throws NativeBridge.BridgeException {
        Task t = tasks.get(sessionId);
        JSONObject out = new JSONObject();
        try {
            JSONObject d = null;
            if (server.status().ready() || (t != null && S_RUNNING.equals(t.state))) {
                try {
                    OpenCodeClient cl = server.client();
                    d = describe(cl.messages(sessionId), t == null ? 0 : Math.max(0, t.baseline));
                } catch (NativeBridge.BridgeException e) {
                    if (t == null) {
                        throw e;
                    }
                    server.note("status: could not read messages (" + e.code + ")");
                }
            }
            if (t != null) {
                // Reconcile a previously uncertain transport outcome against OpenCode's authoritative session log.
                // A lost HTTP connection must not leave the UI stuck on "Outcome unknown" when the server later
                // proves that the assistant turn completed or returned an actual error.
                if (S_UNCERTAIN.equals(t.state) && d != null) {
                    JSONObject recoveredError = d.optJSONObject("error");
                    if (recoveredError != null) {
                        t.state = S_FAILED;
                        String message = recoveredError.optString("message", "The agent reported an error.");
                        try { t.error = new JSONObject().put("code", recoveredError.optString("code", "AGENT_ERROR"))
                                .put("message", message).put("details", recoveredError.optString("details", "")); } catch (Exception ignored) { }
                    } else if (d.optBoolean("completed", false)) {
                        t.state = S_SUCCESS;
                        t.error = null;
                        t.reply = d.optString("reply", t.reply);
                    }
                    persist(t);
                }
                out.put("state", t.state).put("error", t.error == null ? JSONObject.NULL : t.error)
                        .put("reply", t.reply.length() > 0 ? t.reply : (d == null ? "" : S_RUNNING.equals(t.state) ? "" : d.optString("reply", "")));
            } else {
                // After a process restart there is no task record: derive the outcome from the log, never assume.
                String st = S_UNCERTAIN;
                JSONObject err = null;
                if (d != null) {
                    if (d.optJSONObject("error") != null) {
                        st = S_FAILED;
                        err = d.optJSONObject("error");
                    } else if (d.optBoolean("completed", false)) {
                        st = S_SUCCESS;
                    }
                }
                out.put("state", st).put("error", err == null ? (S_UNCERTAIN.equals(st) ? new JSONObject().put("code", "OUTCOME_UNKNOWN").put("message", "The app was restarted while a task was running; its result could not be determined.").put("details", JSONObject.NULL) : JSONObject.NULL) : err)
                        .put("reply", d == null ? "" : d.optString("reply", ""));
            }
            JSONArray steps = d == null ? new JSONArray() : d.optJSONArray("steps");
            out.put("steps", steps == null ? new JSONArray() : steps);
            out.put("changes", d == null || d.optJSONArray("changes") == null ? new JSONArray() : d.optJSONArray("changes"));
            out.put("summary", d == null || d.optJSONArray("summary") == null ? new JSONArray() : d.optJSONArray("summary"));
            out.put("snapshot", t != null && t.snapshot != null ? (Object) t.snapshot : JSONObject.NULL);
        } catch (NativeBridge.BridgeException e) {
            throw e;
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("INTERNAL", "Could not read the task status.", e.getClass().getSimpleName());
        }
        return out;
    }

    /** Pure function over the server's message log (unit-tested). */
    static JSONObject describe(JSONArray msgs, int from) {
        JSONArray steps = new JSONArray(), changes = new JSONArray(), summary = new JSONArray();
        Set<String> seen = new LinkedHashSet<String>();
        StringBuilder reply = new StringBuilder();
        boolean completed = false;
        JSONObject error = null;
        try {
            for (int i = Math.max(0, from); i < msgs.length(); i++) {
                JSONObject m = msgs.optJSONObject(i);
                if (m == null || !"assistant".equals(role(m))) {
                    continue;
                }
                JSONObject info = m.optJSONObject("info");
                JSONObject time = info == null ? null : info.optJSONObject("time");
                completed = time != null && time.optLong("completed", 0) > 0;
                JSONObject e = info == null ? null : info.optJSONObject("error");
                if (e != null) {
                    JSONObject data = e.optJSONObject("data");
                    String msg = data == null ? "" : data.optString("message", "");
                    error = new JSONObject().put("code", codeFor(e.optString("name", ""))).put("message", msg.length() > 0 ? msg : e.optString("name", "The agent reported an error.")).put("details", e.optString("name", ""));
                } else {
                    error = null;
                }
                StringBuilder turn = new StringBuilder();
                JSONArray parts = m.optJSONArray("parts");
                for (int j = 0; parts != null && j < parts.length(); j++) {
                    JSONObject p = parts.optJSONObject(j);
                    if (p == null) {
                        continue;
                    }
                    String type = p.optString("type");
                    if ("text".equals(type) && !p.optBoolean("synthetic", false)) {
                        if (turn.length() > 0) {
                            turn.append("\n");
                        }
                        turn.append(p.optString("text", ""));
                    } else if ("tool".equals(type)) {
                        JSONObject st = p.optJSONObject("state");
                        String status = st == null ? "" : st.optString("status", "");
                        JSONObject input = st == null ? null : st.optJSONObject("input");
                        String tool = p.optString("tool", "tool");
                        String cls = toolClass(tool);
                        String arg = toolArg(input, st);
                        boolean done = "completed".equals(status) || "error".equals(status);
                        boolean ok = "completed".equals(status);
                        JSONObject step = new JSONObject().put("tool", cls).put("name", tool).put("arg", arg).put("done", done).put("ok", ok);
                        if ("error".equals(status)) {
                            step.put("error", st.optString("error", "The tool failed."));
                        }
                        steps.put(step);
                        if (done) {
                            String line = ("write".equals(cls) ? "Edited " : "run".equals(cls) ? "Ran " : "read".equals(cls) ? "Read " : "Searched ") + arg + (ok ? "" : " (FAILED)");
                            summary.put(line);
                            if ("write".equals(cls) && ok && arg.length() > 0 && seen.add(arg)) {
                                changes.put(new JSONObject().put("path", arg));
                            }
                        }
                    }
                }
                if (turn.length() > 0) {
                    reply.setLength(0);
                    reply.append(turn);
                }
            }
        } catch (Exception ignored) {
        }
        JSONObject out = new JSONObject();
        try {
            out.put("steps", steps).put("changes", changes).put("summary", summary).put("reply", reply.toString()).put("completed", completed)
                    .put("error", error == null ? JSONObject.NULL : error);
        } catch (Exception ignored) {
        }
        return out;
    }

    static String role(JSONObject m) {
        JSONObject info = m.optJSONObject("info");
        String r = info == null ? "" : info.optString("role", "");
        return r.length() > 0 ? r : m.optString("role", "");
    }

    static String text(JSONObject m) {
        StringBuilder sb = new StringBuilder();
        JSONArray parts = m.optJSONArray("parts");
        for (int i = 0; parts != null && i < parts.length(); i++) {
            JSONObject p = parts.optJSONObject(i);
            if (p != null && "text".equals(p.optString("type"))) {
                sb.append(p.optString("text", ""));
            }
        }
        return sb.toString();
    }

    static String toolClass(String tool) {
        String t = tool.toLowerCase(java.util.Locale.US);
        if (t.equals("read") || t.equals("list") || t.equals("glob") || t.equals("webfetch")) {
            return "read";
        }
        if (t.equals("grep") || t.equals("search")) {
            return "search";
        }
        if (t.equals("write") || t.equals("edit") || t.equals("patch") || t.equals("multiedit")) {
            return "write";
        }
        return "run";
    }

    private static String toolArg(JSONObject input, JSONObject state) {
        String[] keys = {"filePath", "path", "command", "pattern", "url", "description"};
        for (String k : keys) {
            String v = input == null ? "" : input.optString(k, "");
            if (v.length() > 0) {
                return v.length() > 120 ? v.substring(0, 120) + "..." : v;
            }
        }
        String title = state == null ? "" : state.optString("title", "");
        return title;
    }

    // ----------------------------------------------------------- transcript
    /** Conversation as stored by OpenCode itself, so the UI does not have to keep a plaintext copy of its own. Last 100 turns. */
    JSONArray transcript(String sessionId) throws NativeBridge.BridgeException {
        JSONArray msgs = readyClient().messages(sessionId);
        JSONArray out = new JSONArray();
        int from = Math.max(0, msgs.length() - 100);
        for (int i = from; i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m == null) {
                continue;
            }
            String role = role(m);
            String text;
            if ("assistant".equals(role)) {
                text = describe(new JSONArray().put(m), 0).optString("reply", "");
            } else {
                text = text(m);
            }
            if (text.length() == 0 || (!"user".equals(role) && !"assistant".equals(role))) {
                continue;
            }
            try {
                out.put(new JSONObject().put("role", "user".equals(role) ? "user" : "agent").put("text", text));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // --------------------------------------------------------------- cancel
    /** Asks the server to abort. Never claims cancellation unless the server accepted the request. */
    JSONObject cancel(String sessionId) throws NativeBridge.BridgeException {
        Task t = tasks.get(sessionId);
        if (t == null || !S_RUNNING.equals(t.state)) {
            throw new NativeBridge.BridgeException("NOT_RUNNING", "No task is running in this session.", null);
        }
        server.client().abort(sessionId);                   // OPENCODE_UNSUPPORTED if this server version has no abort route
        t.cancelRequested = true;
        try {
            return new JSONObject().put("cancelRequested", true);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    // --------------------------------------------------------------- models
    /** Dynamic catalogue: the server's own providers, else the installed CLI (`opencode models`). Never hardcoded. */
    JSONObject models() throws NativeBridge.BridgeException {
        List<JSONObject> list = new ArrayList<JSONObject>();
        String source = "server";
        NativeBridge.BridgeException serverErr = null;
        try {
            JSONObject p = readyClient().providers();
            JSONArray provs = p.optJSONArray("providers");
            for (int i = 0; provs != null && i < provs.length(); i++) {
                JSONObject pr = provs.optJSONObject(i);
                if (pr == null) {
                    continue;
                }
                String pid = pr.optString("id", "");
                JSONObject mm = pr.optJSONObject("models");
                if (mm != null) {
                    java.util.Iterator<String> it = mm.keys();
                    while (it.hasNext()) {
                        String key = it.next();
                        JSONObject mo = mm.optJSONObject(key);
                        addModel(list, pid, mo == null || mo.optString("id", "").length() == 0 ? key : mo.optString("id"), mo == null ? key : mo.optString("name", key), pr.optString("name", pid));
                    }
                }
            }
        } catch (NativeBridge.BridgeException e) {
            serverErr = e;
        }
        if (list.isEmpty()) {
            source = "cli";
            try {
                OpenCodeServer.ScriptResult r = host.runScript(
                        "PFX=\"${PREFIX:-/data/data/com.termux/files/usr}\"; oc=\"$(command -v opencode 2>/dev/null)\"; [ -n \"$oc\" ] || oc=\"$PFX/bin/opencode\"; \"$oc\" models 2>&1\n",
                        new String[0], 30000);
                if (r.delivered && r.exitCode == 0) {
                    for (String line : r.stdout.split("\n")) {
                        String l = line.trim();
                        int slash = l.indexOf('/');
                        if (slash > 0 && MODEL_RE.matcher(l).matches()) {
                            addModel(list, l.substring(0, slash), l.substring(slash + 1), l.substring(slash + 1), l.substring(0, slash));
                        }
                    }
                }
            } catch (NativeBridge.BridgeException e) {
                if (serverErr == null) {
                    serverErr = e;
                }
            }
        }
        if (list.isEmpty() && serverErr != null) {
            throw serverErr;
        }
        JSONArray arr = new JSONArray();
        for (JSONObject o : list) {
            arr.put(o);
        }
        try {
            return new JSONObject().put("models", arr).put("selected", host.pref(K_MODEL, "auto")).put("source", source);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void addModel(List<JSONObject> list, String provider, String model, String name, String providerName) {
        try {
            list.add(new JSONObject().put("id", provider + "/" + model).put("providerID", provider).put("modelID", model).put("name", name).put("provider", providerName));
        } catch (Exception ignored) {
        }
    }

    /** "auto" = do not override OpenCode's own model/agent configuration. */
    JSONObject setModel(String id) throws NativeBridge.BridgeException {
        if (!"auto".equals(id)) {
            if (id == null || !MODEL_RE.matcher(id).matches() || id.indexOf("..") >= 0) {
                throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "That is not a valid model id (expected provider/model).", null);
            }
            boolean known = false;
            try {
                JSONArray ms = models().optJSONArray("models");
                for (int i = 0; ms != null && i < ms.length(); i++) {
                    if (id.equals(ms.optJSONObject(i).optString("id"))) {
                        known = true;
                    }
                }
            } catch (NativeBridge.BridgeException e) {
                throw new NativeBridge.BridgeException("MODEL_LIST_UNAVAILABLE", "The model list could not be loaded, so the choice cannot be checked.", e.code);
            }
            if (!known) {
                throw new NativeBridge.BridgeException("MODEL_UNAVAILABLE", "OpenCode does not currently offer " + id + ".", null);
            }
        }
        host.setPref(K_MODEL, id);
        try {
            return new JSONObject().put("selected", id);
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
