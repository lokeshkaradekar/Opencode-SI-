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
 * Long runs: sendMessage() runs on a worker thread. Its HTTP read timeout transfers control to a session-log
 * watcher; it does not cancel the task. The task registry lives in this process-wide object, not in the Activity.
 *
 * Never double-sends: after a transport error the session's message list is read back. The message is re-sent only if
 * the server demonstrably never received it. If it was received but its end was not observed the outcome is
 * reported as UNCERTAIN - never as success.
 */
final class OpenCodeAgent {
    // Only reap a silent model step when no tool is active; never kill a quiet build/install command.
    static final String K_STALL_TIMEOUT_MS = "oc.agent.stallTimeoutMs";
    static final long DEFAULT_STALL_TIMEOUT_MS = 15L * 60L * 1000L;
    private static final long MIN_STALL_TIMEOUT_MS = 1000L;
    private static final long MAX_STALL_TIMEOUT_MS = 24L * 60L * 60L * 1000L;
    interface Events {
        void emit(String name, JSONObject payload);
    }

    static final String S_RUNNING = "RUNNING", S_SUCCESS = "SUCCESS", S_FAILED = "FAILED", S_CANCELLED = "CANCELLED", S_UNCERTAIN = "UNCERTAIN";
    static final String K_MODEL = "oc.model";
    static final String K_SESSION = "oc.session.last";
    static final String K_LASTTASK = "oc.task.last";
    // Appended only to the model-facing prompt. It requests concise, user-visible progress notes,
    // not hidden chain-of-thought. The exact suffix is removed from the transcript shown to users.

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
        volatile OpenCodeClient.EventStream eventStream;
        volatile boolean streamProbeStarted;
        volatile long lastReasoningSignalAt;

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

    private static String withProgressInstruction(String text) {
        if (text == null || text.length() == 0 || text.contains(AgentPromptCatalog.PROGRESS_MARKER)) return text;
        return text + AgentPromptCatalog.PROGRESS_INSTRUCTION;
    }

    private static String removeProgressInstruction(String text) {
        if (text == null) return "";
        int marker = text.indexOf(AgentPromptCatalog.PROGRESS_MARKER);
        return marker < 0 ? text : text.substring(0, marker).trim();
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
        final Task t = new Task(sessionId, withProgressInstruction(text), baseline, pid, mid, "plan".equals(agent) ? "plan" : null);
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
                    OpenCodeClient.EventStream stream = t.eventStream;
                    if (stream != null) stream.close();
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
            long requestStartedAt = System.currentTimeMillis();
            try {
                JSONObject resp = cl.sendMessage(t.sessionId, t.text, t.providerId, t.modelId, t.agentId, new Runnable() {
                    public void run() { probeAndStartPublicTextStream(t, cl); }
                });
                server.note("agent message response received after " + (System.currentTimeMillis() - requestStartedAt) + "ms (attempt " + t.attempts + ", session " + t.sessionId + ")");
                interpret(t, resp);
                return;
            } catch (NativeBridge.BridgeException e) {
                // Keep the actual failure category and safe server detail in diagnostics. This makes
                // provider/model aborts distinguishable from transport loss without logging prompts,
                // credentials, or response bodies. Do not automatically retry server-reported errors.
                server.note("agent message failed after " + (System.currentTimeMillis() - requestStartedAt) + "ms (attempt " + t.attempts + ", code " + e.code + (e.details == null ? "" : ", detail " + e.details) + ")");
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

    private void probeAndStartPublicTextStream(final Task task, final OpenCodeClient client) {
        if (task.streamProbeStarted) return;
        task.streamProbeStarted = true;
        Thread probe = new Thread(new Runnable() {
            public void run() {
                try {
                    java.util.Set<String> routes = client.spec();
                    if (routes != null && routes.contains("GET /event") && S_RUNNING.equals(task.state)) {
                        startPublicTextStream(task, client);
                    }
                } catch (RuntimeException ignored) { }
            }
        }, "opencode-event-capability-probe");
        probe.setDaemon(true);
        probe.start();
    }

    /** Stream only ordinary assistant text deltas from OpenCode. Reasoning/thinking fields are intentionally excluded. */
    private void startPublicTextStream(final Task task, OpenCodeClient client) {
        if (task.eventStream != null) return;
        task.eventStream = client.streamEvents(new OpenCodeClient.EventListener() {
            public void onEvent(JSONObject envelope) {
                if (task == null || !S_RUNNING.equals(task.state)) return;
                JSONObject event = envelope.optJSONObject("payload");
                if (event == null) event = envelope;
                String type = event.optString("type", "");
                if (!"message.part.delta".equals(type)) return;
                JSONObject props = event.optJSONObject("properties");
                if (props == null) return;
                String session = props.optString("sessionID", props.optString("sessionId", ""));
                if (!task.sessionId.equals(session)) return;
                String field = props.optString("field", "");
                String delta = props.optString("delta", "");
                if (delta.length() == 0) return;
                try {
                    Events sink = events;
                    if (sink == null) return;
                    // Never forward raw reasoning tokens. Their arrival is only used as a truthful
                    // activity signal so the UI can distinguish active generation from a silent stall.
                    // The user sees a concise status, while public assistant text and real tools are
                    // streamed separately below.
                    if ("reasoning".equals(field) || "reasoning_content".equals(field)) {
                        long now = System.currentTimeMillis();
                        if (now - task.lastReasoningSignalAt >= 900L) {
                            task.lastReasoningSignalAt = now;
                            sink.emit("opencode.progress.activity", new JSONObject()
                                    .put("sessionId", task.sessionId)
                                    .put("messageId", props.optString("messageID", props.optString("messageId", "")))
                                    .put("partId", props.optString("partID", props.optString("partId", "")))
                                    .put("phase", "analyzing")
                                    .put("time", now));
                        }
                        return;
                    }
                    // Only normal assistant text is displayed verbatim. This is the model's public
                    // response, not private reasoning.
                    if (!"text".equals(field)) return;
                    sink.emit("opencode.progress.delta", new JSONObject()
                            .put("sessionId", task.sessionId)
                            .put("messageId", props.optString("messageID", props.optString("messageId", "")))
                            .put("partId", props.optString("partID", props.optString("partId", "")))
                            .put("delta", delta));
                } catch (Exception ignored) { }
            }
        });
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
        if (t == null || !S_RUNNING.equals(t.state)) return false;
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
        // The server accepted the message. Reconnect to its authoritative session log until it
        // reports a terminal result or the task is explicitly cancelled. The HTTP read timeout above
        // only transfers control here; it does not cancel the run. Reap only a silent model step with
        // no active tool, never a running shell/build tool.
        String lastSnapshot = msgs.toString();
        long lastChangeAt = System.currentTimeMillis();
        while (!Thread.currentThread().isInterrupted() && !t.cancelRequested) {
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
            String snapshot = msgs.toString();
            if (!snapshot.equals(lastSnapshot)) {
                lastSnapshot = snapshot;
                lastChangeAt = System.currentTimeMillis();
            } else if (System.currentTimeMillis() - lastChangeAt >= stalledModelStepTimeoutMs() && !hasActiveTool(msgs, t.baseline)) {
                long silentForMs = System.currentTimeMillis() - lastChangeAt;
                String reason = "Agent model step produced no session-log changes for " + (silentForMs / 1000L)
                        + " seconds; no tool was running or pending. Recovery requested by SI watchdog.";
                server.note("AGENT_STALL_RECOVERY reason=MODEL_STEP_SILENT session=" + t.sessionId
                        + " silentMs=" + silentForMs + " thresholdMs=" + stalledModelStepTimeoutMs() + "; attempting session abort");
                fireRecovery(t, "ABORT_REQUESTED", reason, silentForMs);
                try {
                    server.client().abort(t.sessionId);
                    String details = reason + " Server abort endpoint returned success.";
                    server.note("AGENT_STALL_RECOVERY result=ABORT_CONFIRMED session=" + t.sessionId + " silentMs=" + silentForMs);
                    finish(t, S_FAILED, new NativeBridge.BridgeException("AGENT_STALLED",
                            "The agent stalled and SI aborted the session. " + reason, details));
                } catch (NativeBridge.BridgeException abortError) {
                    String details = reason + " Abort could not be confirmed; server error=" + abortError.code + " (" + abortError.getMessage() + "). Do not retry blindly; inspect session state first.";
                    server.note("AGENT_STALL_RECOVERY result=ABORT_UNCONFIRMED session=" + t.sessionId
                            + " silentMs=" + silentForMs + " error=" + abortError.code);
                    finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("AGENT_STALLED",
                            "The agent stalled, but SI could not confirm that the session was aborted. Inspect the session before retrying.", details));
                }
                return false;
            }
            try {
                Thread.sleep(2000);
                msgs = server.client().messages(t.sessionId);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            } catch (NativeBridge.BridgeException e2) {
                // No elapsed-time cutoff: if the server is still healthy, keep reconnecting no
                // matter how long the model/tool is quiet. If the server is actually down, try
                // the normal auto-recovery path; only a confirmed failed recovery becomes uncertain.
                try {
                    OpenCodeServer.Status recovery = server.ensureReady(true, false);
                    if (recovery == null || !recovery.ready()) break;
                } catch (RuntimeException recoveryError) {
                    if (!server.status().ready()) break;
                }
                try { Thread.sleep(2000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
        if (t.cancelRequested) {
            finish(t, S_CANCELLED, null);
        } else {
            finish(t, S_UNCERTAIN, new NativeBridge.BridgeException("OUTCOME_UNKNOWN",
                    "The progress watcher was interrupted before OpenCode returned a final status.", null));
        }
        return false;
    }

    /** Timeout can be changed in SI preferences; invalid values fall back safely to the 15-minute default. */
    long stalledModelStepTimeoutMs() {
        try {
            String raw = host.pref(K_STALL_TIMEOUT_MS, String.valueOf(DEFAULT_STALL_TIMEOUT_MS));
            long value = Long.parseLong(raw == null ? "" : raw.trim());
            if (value < MIN_STALL_TIMEOUT_MS || value > MAX_STALL_TIMEOUT_MS) return DEFAULT_STALL_TIMEOUT_MS;
            return value;
        } catch (Exception ignored) {
            return DEFAULT_STALL_TIMEOUT_MS;
        }
    }

    private void fireRecovery(Task t, String phase, String reason, long silentForMs) {
        Events ev = events;
        if (ev == null) return;
        try {
            ev.emit("opencode.task.recovery", new JSONObject()
                    .put("sessionId", t.sessionId).put("phase", phase)
                    .put("reason", reason).put("silentForMs", silentForMs)
                    .put("thresholdMs", stalledModelStepTimeoutMs()));
        } catch (Exception ignored) { }
    }

    private static boolean hasActiveTool(JSONArray msgs, int from) {
        for (int i = Math.max(0, from); i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m == null || !"assistant".equals(role(m))) continue;
            JSONArray parts = m.optJSONArray("parts");
            for (int j = 0; parts != null && j < parts.length(); j++) {
                JSONObject part = parts.optJSONObject(j);
                if (part == null || !"tool".equals(part.optString("type"))) continue;
                JSONObject state = part.optJSONObject("state");
                String status = state == null ? "" : state.optString("status", "");
                if ("running".equals(status) || "pending".equals(status)) return true;
            }
        }
        return false;
    }

    /** The blocking POST returned: read the server's own verdict (info.error) rather than assuming success. */
    private void interpret(Task t, JSONObject resp) {
        if (t == null || !S_RUNNING.equals(t.state)) return; // a watchdog/cancel outcome is authoritative
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
            // An AbortError returned by OpenCode is not proof that the user pressed Stop.
            // Only the app's explicit cancel request may produce CANCELLED; provider/tool/server
            // aborts must remain FAILED so the UI shows the real error instead of a false "Stopped".
            finish(t, t.cancelRequested ? S_CANCELLED : S_FAILED, new NativeBridge.BridgeException(codeFor(name), msg, name));
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
        if (t == null || !S_RUNNING.equals(t.state)) return;
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
            ev.emit("opencode.task", new JSONObject().put("sessionId", t.sessionId).put("state", t.state)
                    .put("error", t.error == null ? JSONObject.NULL : t.error));
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
            JSONArray rawMsgs = null;
            if (server.status().ready() || (t != null && S_RUNNING.equals(t.state))) {
                try {
                    OpenCodeClient cl = server.client();
                    rawMsgs = cl.messages(sessionId);
                    d = describe(rawMsgs, t == null ? 0 : Math.max(0, t.baseline));
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
            out.put("activity", d == null || rawMsgs == null ? new JSONArray() : activityFeed(rawMsgs, t == null ? 0 : Math.max(0, t.baseline)));
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

    /**
     * User-visible activity feed derived from the official OpenCode message/part log.
     * This intentionally excludes private model reasoning and file-read/discovery tools; it shows
     * visible assistant updates, edits, shell/build commands, outputs and failures only.
     */
    static JSONArray activityFeed(JSONArray msgs, int from) {
        JSONArray out = new JSONArray();
        try {
            for (int i = Math.max(0, from); i < msgs.length(); i++) {
                JSONObject m = msgs.optJSONObject(i);
                if (m == null || !"assistant".equals(role(m))) continue;
                JSONObject info = m.optJSONObject("info");
                long created = info == null ? 0 : info.optLong("time", 0);
                if (created <= 0 && info != null) {
                    JSONObject tm = info.optJSONObject("time");
                    created = tm == null ? 0 : tm.optLong("created", 0);
                }
                JSONArray parts = m.optJSONArray("parts");
                for (int j = 0; parts != null && j < parts.length(); j++) {
                    JSONObject part = parts.optJSONObject(j);
                    if (part == null) continue;
                    String type = part.optString("type", "");
                    if ("text".equals(type) && !part.optBoolean("synthetic", false)) {
                        String text = part.optString("text", "").trim();
                        if (text.length() > 0) out.put(new JSONObject().put("kind", "update").put("label", "Progress update").put("detail", clip(text, 4000)).put("state", "done").put("time", created));
                    } else if ("tool".equals(type)) {
                        String name = part.optString("tool", "tool");
                        String cls = toolClass(name);
                        if ("read".equals(cls) || "search".equals(cls) || "meta".equals(cls)) continue;
                        JSONObject state = part.optJSONObject("state");
                        JSONObject input = state == null ? null : state.optJSONObject("input");
                        String status = state == null ? "running" : state.optString("status", "running");
                        String label = "write".equals(cls) ? "Editing code" : "run".equals(cls) ? "Running command" : name;
                        String arg = toolDetail(input, state, cls);
                        JSONObject ev = new JSONObject().put("kind", "tool").put("tool", name).put("label", label).put("detail", clip(arg, 4000))
                                .put("state", "completed".equals(status) ? "done" : "error".equals(status) ? "failed" : "running").put("time", created);
                        if ("write".equals(cls) && input != null) {
                            String code = input.optString("content", "");
                            if (code.length() == 0) code = input.optString("newString", input.optString("patch", ""));
                            if (code.length() == 0 && input.has("edits")) code = input.opt("edits").toString();
                            if (code.length() > 0) ev.put("code", clip(code, 16000));
                        }
                        if (state != null) {
                            String output = state.optString("output", "");
                            if (output.length() == 0) {
                                JSONObject meta = state.optJSONObject("metadata");
                                if (meta != null) output = meta.optString("output", meta.optString("stdout", ""));
                            }
                            if (output.length() > 0) ev.put("output", clip(output, 8000));
                            String err = state.optString("error", "");
                            if (err.length() > 0) ev.put("error", clip(err, 2000));
                        }
                        out.put(ev);
                    }
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    private static String toolDetail(JSONObject input, JSONObject state, String cls) {
        if (input == null) return toolArg(input, state);
        String command = input.optString("command", "");
        if (command.length() > 0) return command;
        String path = input.optString("filePath", input.optString("path", ""));
        String description = input.optString("description", "");
        if ("write".equals(cls)) {
            String content = input.optString("content", "");
            return (path.length() > 0 ? path : description) + (content.length() > 0 ? "\n\nCode/content supplied to the editor: " + content.length() + " characters" : "");
        }
        if (path.length() > 0) return path;
        if (description.length() > 0) return description;
        return toolArg(input, state);
    }

    private static String clip(String value, int max) {
        if (value == null) return "";
        String s = value.trim();
        return s.length() <= max ? s : s.substring(0, max) + "\n… output truncated for display";
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
                        // Todo/planning tools maintain the agent's internal checklist; they are not
                        // commands, file edits, or project work. Never report "Ran 4 todos" as work done.
                        if ("meta".equals(cls)) continue;
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
        String t = tool == null ? "" : tool.toLowerCase(java.util.Locale.US);
        // OpenCode todo/planning calls are internal bookkeeping, not execution evidence.
        if (t.equals("todowrite") || t.equals("todoread") || t.equals("todo_write") || t.equals("todo_read") || t.equals("plan")) return "meta";
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

    // ----------------------------------------------------------- usage / cost accounting
    /** Returns provider-reported token/cost metadata when the OpenCode server exposes it. No guessed prices. */
    JSONObject usage(String sessionId) throws Exception {
        JSONArray msgs = readyClient().messages(sessionId);
        long input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
        double cost = 0; int pricedMessages = 0;
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i); if (m == null || !"assistant".equals(role(m))) continue;
            // OpenCode versions commonly put usage under message.info, while older or
            // compatible servers expose it at the message root. Prefer info, then fall back.
            JSONObject info = m.optJSONObject("info");
            JSONObject tokens = info == null ? null : info.optJSONObject("tokens");
            if (tokens == null) tokens = m.optJSONObject("tokens");
            if (tokens != null) {
                input += tokens.optLong("input", 0); output += tokens.optLong("output", 0);
                reasoning += tokens.optLong("reasoning", 0);
                JSONObject cache = tokens.optJSONObject("cache");
                if (cache != null) { cacheRead += cache.optLong("read", 0); cacheWrite += cache.optLong("write", 0); }
            }
            if (info != null && info.has("cost")) { cost += info.optDouble("cost", 0); pricedMessages++; }
            else if (m.has("cost")) { cost += m.optDouble("cost", 0); pricedMessages++; }
        }
        return new JSONObject().put("inputTokens", input).put("outputTokens", output).put("reasoningTokens", reasoning)
            .put("cacheReadTokens", cacheRead).put("cacheWriteTokens", cacheWrite)
            .put("reportedCost", cost).put("hasReportedCost", pricedMessages > 0).put("source", "OpenCode session message metadata");
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
                text = removeProgressInstruction(text(m));
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
