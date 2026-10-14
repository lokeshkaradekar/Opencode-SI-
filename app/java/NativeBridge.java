package com.opencode.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.StatFs;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * The ONLY object exposed to page JavaScript (as window.AndroidBridge). One entry point, request(json),
 * dispatches to an explicit allowlist of operations. There is no "execute anything" method.
 *
 *   JavaScript -> NativeBridge -> SecureStore            (provider secrets, daemon token)
 *                              -> TermuxBackend -> Termux daemon -> PTY / filesystem / git / snapshots / agent
 *
 * Reply contract (identical for success and failure):
 *   {success:boolean, data:any|null, error:{code,message,details}|null, requestId:string}
 *
 * Security rules enforced here (the daemon enforces them again independently):
 *   - unknown method -> UNKNOWN_METHOD; arguments are read with typed getters, never evaluated
 *   - terminal commands must pass CommandPolicy (command allowlist, no $(...) / backticks / subshells)
 *   - git is reachable only through the fixed GIT_OPS list, never as a free-form command line
 *   - paths are sent project-relative; the daemon confines them to the project and rejects symlink escapes
 *   - secrets are write-only from JS: setSecret / deleteSecret / hasSecret. No method ever returns a secret
 *   - errors carry a code, a user-readable message and short technical details: no stack traces, no tokens
 */
public class NativeBridge {
    static final String APP_VERSION = "0.4.0";
    static final String WORKSPACE_DISPLAY = "~/OpenCodeProjects";

    /** Error with a stable code, a safe message for the user and optional short technical details. */
    static class BridgeException extends Exception {
        final String code;
        final String details;

        BridgeException(String code, String message, String details) {
            super(message);
            this.code = code;
            this.details = details;
        }
    }

    // methods that must never wait behind long-running work (cancel a command while all workers are busy)
    private static final Set<String> CONTROL = new HashSet<String>(Arrays.asList(
            "cancelCommand", "interruptCommand", "sendInput", "resizeTerminal", "agentCancel", "agentStatus",
            "opencodeStatus", "opencodeRecheck", "opencodeDiagnostics", "opencodeStop", "openSupportLink"));
    private static final Set<String> GIT_OPS = new HashSet<String>(Arrays.asList(
            "init", "status", "diff", "log", "branch", "checkout", "add", "restore", "commit", "fetch", "pull", "push",
            "stash", "rev-parse", "clone"));
    private static final Set<String> PROVIDERS = new HashSet<String>(Arrays.asList("hosted", "compatible", "local"));
    private static final Pattern PROJECT_RE = Pattern.compile("^[A-Za-z0-9._ -]{1,64}$");
    private static final Pattern REQUEST_ID_RE = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final int MAX_REQUEST_CHARS = 12 * 1024 * 1024;

    private final Activity activity;
    private final WebView web;
    private final SecureStore secrets;
    private final TermuxBackend termux;
    private final OpenCodeRuntime oc;
    private final OpenCodeAgent.Events ocEvents = new OpenCodeAgent.Events() {
        public void emit(String name, JSONObject payload) {
            NativeBridge.this.emit(name, payload);
        }
    };
    private final SharedPreferences prefs;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final ExecutorService control = Executors.newFixedThreadPool(2);
    private volatile String activeProject;

    public NativeBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.secrets = new SecureStore(activity);
        this.termux = new TermuxBackend(activity, secrets);
        this.oc = OpenCodeRuntime.get(activity);
        this.oc.attach(ocEvents);
        this.prefs = activity.getSharedPreferences("opencode_si_backend", Context.MODE_PRIVATE);
        String saved = prefs.getString("active_project", null);
        if (saved != null && PROJECT_RE.matcher(saved).matches()) {
            this.activeProject = saved;       // restored after the process was killed; verified on first use
        }
    }

    public void shutdown() {
        oc.detach(ocEvents);                  // the server and any running task keep going: they belong to the process, not the screen
        pool.shutdownNow();
        control.shutdownNow();
        termux.close();
    }

    /** Called by MainActivity after the runtime-permission dialog for RUN_COMMAND. */
    void onPermissionResult(boolean granted) {
        try {
            emit("permission", new JSONObject().put("name", TermuxBackend.PERM_RUN_COMMAND).put("granted", granted));
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------------ entry
    @JavascriptInterface
    public void request(final String json) {
        ExecutorService target = pool;
        String peek = peekMethod(json);
        if (peek != null && CONTROL.contains(peek)) {
            target = control;
        }
        try {
            target.submit(new Runnable() {
                public void run() {
                    handle(json);
                }
            });
        } catch (RuntimeException rejected) {
            // pool shut down (activity closing): nothing to deliver to
        }
    }

    private static String peekMethod(String json) {
        try {
            return new JSONObject(json).optString("method", null);
        } catch (Exception e) {
            return null;
        }
    }

    private void handle(String json) {
        String requestId = "";
        JSONObject reply = new JSONObject();
        try {
            if (json == null || json.length() > MAX_REQUEST_CHARS) {
                throw new BridgeException("INVALID_ARGUMENT", "The request is too large.", null);
            }
            JSONObject req = new JSONObject(json);
            String rid = req.optString("requestId", "");
            if (!REQUEST_ID_RE.matcher(rid).matches()) {
                throw new BridgeException("INVALID_ARGUMENT", "Missing or invalid requestId.", null);
            }
            requestId = rid;
            JSONObject args = req.optJSONObject("args");
            Object data = dispatch(req.getString("method"), args == null ? new JSONObject() : args);
            reply.put("success", true).put("data", data == null ? JSONObject.NULL : data).put("error", JSONObject.NULL);
        } catch (BridgeException e) {
            fail(reply, e.code, e.getMessage(), e.details);
        } catch (SecureStore.SecureStoreException e) {
            fail(reply, e.code, e.getMessage(), null);
        } catch (Exception e) {
            fail(reply, "INTERNAL", "Unexpected native error.", e.getClass().getSimpleName());   // class name only: no message, no stack
        }
        try {
            reply.put("requestId", requestId);
        } catch (Exception ignored) {
        }
        deliver(requestId, reply.toString());
    }

    private static void fail(JSONObject reply, String code, String msg, String details) {
        try {
            JSONObject err = new JSONObject().put("code", code).put("message", msg).put("details", details == null ? JSONObject.NULL : details);
            reply.put("success", false).put("data", JSONObject.NULL).put("error", err);
        } catch (Exception ignored) {
        }
    }

    private void deliver(String requestId, final String replyJson) {
        if (requestId.length() == 0) {
            return;                                   // cannot be matched by the page anyway
        }
        // Both arguments are JSON string literals, so nothing in them can break out into script.
        final String js = "window.__bridgeResolve(" + JSONObject.quote(requestId) + "," + JSONObject.quote(replyJson) + ")";
        runJs(js);
    }

    /** Pushes an event to the page (live terminal output, permission results). */
    void emit(String name, JSONObject payload) {
        runJs("window.__bridgeEvent && window.__bridgeEvent(" + JSONObject.quote(name) + "," + JSONObject.quote(payload.toString()) + ")");
    }

    private void runJs(final String js) {
        try {
            activity.runOnUiThread(new Runnable() {
                public void run() {
                    web.evaluateJavascript(js, null);
                }
            });
        } catch (RuntimeException ignored) {
        }
    }

    // --------------------------------------------------------------- dispatch
    private Object dispatch(String method, JSONObject a) throws Exception {
        switch (method) {
            // ---- environment / connection
            case "getEnvironment": return environment();
            case "healthCheck": return healthCheck();
            case "daemonStatus": return daemonStatus();
            case "configureDaemon": termux.configure(a.optInt("port", termux.port()), a.optString("token", null)); return daemonStatus();
            case "startDaemon": termux.ensureDaemon(true); return daemonStatus();
            case "requestTermuxPermission": requestPermission(); return new JSONObject().put("requested", true);
            case "beginSetupInstall": return termux.beginSetupInstall();
            case "setupInstallProgress": return termux.setupInstallProgress();
            case "copyText": return copyText(a.optString("text", ""));
            // ---- projects
            case "listProjects": return listProjects();
            case "createProject": return createProject(a.optString("name", ""), a.optString("parent", ""));
            case "pickProjectLocation": pickProjectFolder(); return new JSONObject().put("requested", true);
            case "renameProject": return renameProject(a.optString("id", ""), a.optString("name", ""));
            case "deleteProject": return deleteProject(a.optString("id", ""));
            case "openProject": return openProject(a.optString("id", ""));
            case "cloneProject": return cloneProject(a.optString("url", ""));
            case "detectProject": return daemon("/v1/projects/detect", project(), a);
            case "importZip": throw new BridgeException("NOT_IMPLEMENTED", "Importing a ZIP is not available yet. Clone a repository or copy files into ~/OpenCodeProjects from Termux.", null);
            // ---- filesystem
            case "listFiles": return listFiles(a.optString("path", ""));
            case "readFile": return readFile(a.optString("path", ""));
            case "writeFile": return writeFile(a.optString("path", ""), a, false);
            case "createFile": return writeFile(a.optString("path", ""), a, true);
            case "createFolder": return fs("mkdir", new JSONObject().put("path", a.optString("path", "")).put("exist_ok", false));
            case "deleteFile": return fs("delete", new JSONObject().put("path", a.optString("path", "")).put("recursive", true));
            case "moveFile": return fs("rename", new JSONObject().put("from", a.optString("from", "")).put("to", a.optString("to", "")));
            case "exists": return new JSONObject().put("exists", fs("stat", new JSONObject().put("path", a.optString("path", ""))).optBoolean("exists", false));
            case "searchFiles": return searchFiles(a.optString("query", ""));
            // ---- terminal
            case "runCommand": return runCommand(a.optString("command", ""), a.optBoolean("confirmed", false), a.optLong("timeoutMs", 0));
            case "cancelCommand": return termux.cancel(project());
            case "interruptCommand": return termux.interrupt(project());
            case "sendInput": return termux.stdin(project(), a.optString("data", ""));
            case "resizeTerminal": return termux.resize(project(), a.optInt("cols", 80), a.optInt("rows", 24));
            case "restartTerminal": return termux.restartSession(project());
            // ---- git
            case "gitStatus": return gitCall("status", new JSONObject());
            case "gitDiff": return gitCall("diff", new JSONObject().put("path", a.isNull("path") ? JSONObject.NULL : a.optString("path")));
            case "gitLog": return gitLog();
            case "gitCommit": return gitCall("commit", new JSONObject().put("message", a.optString("message", "")));
            case "gitRestore": return gitCall("restore", new JSONObject().put("path", a.optString("path", "")).put("confirmed", a.optBoolean("confirmed", false)));
            case "gitOp": return gitOp(a);
            // ---- snapshots
            case "snapshotCreate": return daemon("/v1/snapshots/create", project(), new JSONObject().put("label", a.optString("label", "Snapshot")).put("good", a.optBoolean("good", false)));
            case "snapshotList": return daemonList("/v1/snapshots/list", project(), new JSONObject());
            case "snapshotInspect": return daemon("/v1/snapshots/inspect", project(), new JSONObject().put("id", a.optString("id", "")));
            case "snapshotRollback": return daemon("/v1/snapshots/rollback", project(), new JSONObject().put("id", a.optString("id", "")).put("confirmed", a.optBoolean("confirmed", false)));
            // ---- agent
            case "agentStart": return new JSONObject().put("sessionId", oc.agent.startSession()).put("agent", "opencode");
            case "agentSend": return agentSend(a);
            case "agentResume": return oc.agent.send(a.optString("sessionId", ""), "Please continue the previous task from where it stopped.");
            case "agentCancel": return oc.agent.cancel(a.optString("sessionId", ""));
            case "agentStatus": return oc.agent.status(a.optString("sessionId", ""));
            case "agentHistory": return oc.agent.transcript(a.optString("sessionId", ""));

            // ---- official OpenCode server lifecycle (Termux)
            case "opencodeStatus": return ocStatus();
            case "opencodeEnsure": oc.server.ensureReady(true, a.optBoolean("force", false)); return ocStatus();
            case "opencodeRecheck": oc.server.recheck(); return ocStatus();
            case "opencodeStop": oc.server.stopManaged(a.optBoolean("force", false)); return ocStatus();
            case "opencodeDiagnostics": return ocDiagnostics();
            case "opencodeSetupChecks": return oc.server.setupChecks();
            case "termuxSetupStorage": return oc.server.requestStorageSetup();
            case "opencodeGetWorkspace": return ocWorkspace();
            case "opencodeSetWorkspace": return ocSetWorkspace(a.optString("mode", "custom"), a.optString("path", ""));
            case "opencodePickWorkspace": pickFolder(); return new JSONObject().put("requested", true);
            case "opencodeSetPassword": oc.setServerPassword(a.optString("value", "")); return new JSONObject().put("stored", true);
            case "opencodeSessions": return oc.agent.sessions();
            case "opencodeModels": return oc.agent.models();
            case "opencodeSetModel": return oc.agent.setModel(a.optString("id", "auto"));
            case "openAppSettings": openAppSettings(); return new JSONObject().put("opened", true);
            case "openTermux": openTermux(); return new JSONObject().put("opened", true);
            case "openSupportLink": openSupportLink(a.optString("destination", ""), a.optString("subject", ""), a.optString("body", "")); return new JSONObject().put("opened", true);

            case "providerHealth": return providerHealth(a.optString("id", ""));
            case "listModels": return listModels(a.optString("id", ""));
            case "getProviderConfig": return providerConfig(a.optString("id", ""));
            case "setProviderConfig": return setProviderConfig(a);
            case "setSecret": secrets.put(secretId(a.optString("id", "")), a.optString("value", "")); return new JSONObject().put("stored", true);
            case "deleteSecret": secrets.delete(secretId(a.optString("id", ""))); return new JSONObject().put("deleted", true);
            case "hasSecret": return new JSONObject().put("exists", secrets.has(secretId(a.optString("id", ""))));
            // ---- recovery
            case "repair": return repair(a.optInt("level", 0));
            case "setBackend": return setBackend(a.optString("name", ""));
            default:
                throw new BridgeException("UNKNOWN_METHOD", "Unknown bridge method: " + method, null);
        }
    }

    // ------------------------------------------------------------ helpers
    private String project() throws BridgeException {
        String p = activeProject;
        if (p == null) {
            throw new BridgeException("NO_PROJECT", "No project is open.", null);
        }
        return p;
    }

    private static String secretId(String id) throws BridgeException {
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        return "provider." + id;
    }

    private static JSONObject body(String project, JSONObject extra) throws Exception {
        JSONObject b = new JSONObject();
        if (extra != null) {
            Iterator<String> it = extra.keys();
            while (it.hasNext()) {
                String k = it.next();
                b.put(k, extra.get(k));
            }
        }
        if (project != null) {
            b.put("project", project);           // always the bridge's own value: JS cannot target another project
        }
        return b;
    }

    private JSONObject daemon(String path, String project, JSONObject extra) throws Exception {
        termux.ensureDaemon(true);
        return TermuxBackend.data(termux.postSlow(path, body(project, extra), 120000));
    }

    private JSONArray daemonList(String path, String project, JSONObject extra) throws Exception {
        termux.ensureDaemon(true);
        return TermuxBackend.dataArray(termux.postSlow(path, body(project, extra), 120000));
    }

    private JSONObject fs(String op, JSONObject extra) throws Exception {
        return daemon("/v1/fs/" + op, project(), extra);
    }

    private JSONObject gitCall(String op, JSONObject extra) throws Exception {
        return daemon("/v1/git/" + op, project(), extra);
    }

    private JSONObject projectMeta(String id, long updatedMs, boolean git) throws Exception {
        String path = WORKSPACE_DISPLAY + "/" + id;
        return projectMeta(id, updatedMs, git, path);
    }

    private JSONObject projectMeta(String id, long updatedMs, boolean git, String path) throws Exception {
        return new JSONObject().put("id", id).put("name", id).put("backend", "termux").put("agent", "opencode")
                .put("updated", updatedMs).put("path", path).put("git", git);
    }

    // ---------------------------------------------------------------- projects
    private JSONArray listProjects() throws Exception {
        termux.ensureDaemon(true);
        JSONArray src = TermuxBackend.dataArray(termux.call("GET", "/v1/projects", null, 20000));
        JSONArray out = new JSONArray();
        for (int i = 0; i < src.length(); i++) {
            JSONObject p = src.getJSONObject(i);
            out.put(projectMeta(p.getString("id"), p.optLong("updated", 0), p.optBoolean("git", false), p.optString("path", WORKSPACE_DISPLAY + "/" + p.getString("id"))));
        }
        return out;
    }

    private JSONObject createProject(String name, String parent) throws Exception {
        termux.ensureDaemon(true);
        JSONObject body = new JSONObject().put("name", name);
        if (parent != null && !parent.trim().isEmpty()) {
            String requestedParent = OpenCodeServer.validateWorkspace(parent.trim());
            // Never send a custom-location create request to a daemon that has not explicitly
            // advertised support. Older daemons silently ignored unknown JSON fields and created
            // projects in ~/OpenCodeProjects, leaving the user with a misleading success.
            // Repair the running daemon automatically if its capability endpoint is missing or stale.
            // This updates the bundled Python files, safely stops the old daemon, starts the new one,
            // and verifies the live capability response before any project is created.
            termux.ensureCustomProjectSupport();
            body.put("parent", requestedParent);
            body.put("require_parent", true);
        }
        JSONObject p = TermuxBackend.data(termux.post("/v1/projects", body));
        if (parent != null && !parent.trim().isEmpty()) {
            String expected = OpenCodeServer.validateWorkspace(parent.trim());
            String actual = p.optString("path", "");
            String normalizedExpected = expected.endsWith("/") ? expected.substring(0, expected.length() - 1) : expected;
            if (!actual.equals(normalizedExpected + "/" + name)) {
                throw new BridgeException("PROJECT_PATH_MISMATCH", "The backend returned a different project path. Expected " + normalizedExpected + "/" + name + " but got " + (actual.length() == 0 ? "an unknown path" : actual) + ". The app refused to open it.", p.toString());
            }
        }
        return openProject(p.getString("id"));
    }

    private JSONObject renameProject(String id, String name) throws Exception {
        if (!PROJECT_RE.matcher(id).matches() || id.startsWith(".") || !PROJECT_RE.matcher(name).matches() || name.startsWith(".")) {
            throw new BridgeException("INVALID_ARGUMENT", "Invalid project name.", null);
        }
        termux.ensureDaemon(true);
        JSONObject result;
        try {
            result = TermuxBackend.data(termux.post("/v1/projects/rename", new JSONObject().put("id", id).put("name", name)));
        } catch (BridgeException e) {
            // Backward compatibility: an already-running older daemon may not yet have the project routes.
            // Use Termux RUN_COMMAND with positional arguments (never interpolated user input) as a safe fallback.
            if (!isMissingProjectEndpoint(e)) throw e;
            result = renameProjectViaTermux(id, name);
        }
        if (id.equals(activeProject)) {
            activeProject = name;
            String activePath = result.optString("path", WORKSPACE_DISPLAY + "/" + name);
            prefs.edit().putString("active_project", name).putString("active_project_path", activePath).commit();
            termux.forgetProject(id);
        }
        return projectMeta(name, result.optLong("updated", System.currentTimeMillis()), result.optBoolean("git", false));
    }

    private JSONObject renameProjectViaTermux(String id, String name) throws Exception {
        String script = "set -eu\nroot=\"$HOME/OpenCodeProjects\"\nsrc=\"$root/$1\"\ndst=\"$root/$2\"\n[ -d \"$src\" ] && [ ! -L \"$src\" ] || { echo 'Source project does not exist or is not a real directory.' >&2; exit 4; }\n[ ! -e \"$dst\" ] || { echo 'A project with that name already exists.' >&2; exit 5; }\n[ \"$(realpath \"$src\")\" != \"$root\" ] || exit 6\nmv -- \"$src\" \"$dst\"\nprintf '{\"id\":\"%s\",\"name\":\"%s\",\"updated\":%s,\"git\":%s}\\n' \"$2\" \"$2\" \"$(date +%s)000\" \"$( [ -d \"$dst/.git\" ] && echo true || echo false )\"";
        OpenCodeServer.ScriptResult r = termux.runScript(script, new String[]{id, name}, 30000);
        requireScriptSuccess(r, "rename project");
        return new JSONObject().put("id", name).put("name", name).put("updated", System.currentTimeMillis());
    }

    private JSONObject deleteProject(String id) throws Exception {
        if (!PROJECT_RE.matcher(id).matches() || id.startsWith(".")) {
            throw new BridgeException("INVALID_ARGUMENT", "Invalid project name.", null);
        }
        termux.ensureDaemon(true);
        JSONObject result;
        try {
            result = TermuxBackend.data(termux.post("/v1/projects/delete", new JSONObject().put("id", id)));
        } catch (BridgeException e) {
            if (!isMissingProjectEndpoint(e)) throw e;
            String script = "set -eu\nroot=\"$HOME/OpenCodeProjects\"\np=\"$root/$1\"\n[ -d \"$p\" ] && [ ! -L \"$p\" ] || { echo 'Project does not exist or is not a real directory.' >&2; exit 4; }\n[ \"$(realpath \"$p\")\" != \"$root\" ] || exit 6\ncase \"$(realpath \"$p\")/\" in \"$(realpath \"$root\")/\"*) ;; *) echo 'Project path escaped workspace.' >&2; exit 7;; esac\nrm -rf -- \"$p\"\nprintf '{\"id\":\"%s\",\"deleted\":true}\\n' \"$1\"";
            OpenCodeServer.ScriptResult r = termux.runScript(script, new String[]{id}, 30000);
            requireScriptSuccess(r, "delete project");
            result = new JSONObject().put("id", id).put("deleted", true);
        }
        if (id.equals(activeProject)) {
            termux.forgetProject(id);
            activeProject = null;
            prefs.edit().remove("active_project").commit();
        }
        return result;
    }

    // Older daemon builds report an unknown route as UNKNOWN_ROUTE (not NOT_FOUND).
    // Only use the shell fallback for a missing route, never for a missing project or other 404.
    static boolean isMissingProjectEndpoint(BridgeException e) {
        if (e == null) return false;
        String code = e.code == null ? "" : e.code;
        String msg = (e.getMessage() == null ? "" : e.getMessage()).toLowerCase(java.util.Locale.US);
        String detail = (e.details == null ? "" : String.valueOf(e.details)).toLowerCase(java.util.Locale.US);
        boolean mentionsEndpoint = msg.contains("endpoint") || detail.contains("endpoint");
        return ("UNKNOWN_ROUTE".equals(code) && (mentionsEndpoint || msg.contains("no such")))
                || ("NOT_FOUND".equals(code) && mentionsEndpoint);
    }

    private static void requireScriptSuccess(OpenCodeServer.ScriptResult r, String operation) throws BridgeException {
        if (r == null || !r.delivered) throw new BridgeException("TERMUX_NO_RESULT", "Termux did not return a result while trying to " + operation + ". Open Termux once, then retry.", r == null ? null : r.error);
        if (r.exitCode != 0) {
            String msg = r.stderr == null || r.stderr.trim().length() == 0 ? "Termux could not " + operation + "." : r.stderr.trim();
            throw new BridgeException("PROJECT_OPERATION_FAILED", msg, "exit=" + r.exitCode + (r.stdout.length() > 0 ? "; " + r.stdout.trim() : ""));
        }
    }

    private JSONObject cloneProject(String url) throws Exception {
        termux.ensureDaemon(true);
        JSONObject p = TermuxBackend.data(termux.postSlow("/v1/git/clone", new JSONObject().put("url", url), 660000));
        return openProject(p.getString("id"));
    }

    private JSONObject openProject(String id) throws Exception {
        if (!PROJECT_RE.matcher(id).matches() || id.startsWith(".")) {
            throw new BridgeException("INVALID_ARGUMENT", "Invalid project name.", null);
        }
        termux.ensureDaemon(true);
        // detect doubles as an existence check (NOT_FOUND if the folder is not under ~/OpenCodeProjects)
        JSONObject det = TermuxBackend.data(termux.post("/v1/projects/detect", new JSONObject().put("project", id)));
        if (activeProject != null && !activeProject.equals(id)) {
            termux.forgetProject(activeProject);
        }
        activeProject = id;
        String activePath = WORKSPACE_DISPLAY + "/" + id;
        JSONArray projects = TermuxBackend.dataArray(termux.call("GET", "/v1/projects", null, 20000));
        for (int i = 0; i < projects.length(); i++) {
            JSONObject item = projects.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) { activePath = item.optString("path", activePath); break; }
        }
        prefs.edit().putString("active_project", id).putString("active_project_path", activePath).commit();
        return projectMeta(id, System.currentTimeMillis(), det.optJSONArray("types") != null && det.optJSONArray("types").toString().contains("\"git\""), activePath)
                .put("detected", det);
    }

    // ------------------------------------------------------------- filesystem
    private JSONArray listFiles(String path) throws Exception {
        JSONObject r = fs("list", new JSONObject().put("path", path));
        JSONArray entries = r.optJSONArray("entries");
        JSONArray out = new JSONArray();
        for (int i = 0; entries != null && i < entries.length(); i++) {
            JSONObject e = entries.getJSONObject(i);
            if (e.optBoolean("outside_project", false)) {
                continue;                                  // symlink pointing outside the project: never shown, never followed
            }
            out.put(new JSONObject().put("name", e.getString("name")).put("path", e.getString("path"))
                    .put("type", "dir".equals(e.optString("type")) ? "dir" : "file").put("size", e.optLong("size", 0))
                    .put("symlink", e.optBoolean("symlink", false)));
        }
        return out;
    }

    private JSONObject readFile(String path) throws Exception {
        JSONObject r = fs("read", new JSONObject().put("path", path).put("limit", 1024 * 1024));
        if (r.optBoolean("binary", false)) {
            throw new BridgeException("BINARY_FILE", "This is a binary file and cannot be shown in the editor.", null);
        }
        if (r.optBoolean("truncated", false)) {
            throw new BridgeException("FILE_TOO_LARGE", "The file is larger than 1 MB. Use the terminal (head, tail, wc) instead.", null);
        }
        return new JSONObject().put("path", r.getString("path")).put("content", r.optString("content", "")).put("size", r.optLong("size", 0))
                .put("mtimeNs", r.optLong("mtime_ns", 0)).put("lineEndings", r.optString("line_endings", "lf"));
    }

    private JSONObject writeFile(String path, JSONObject a, boolean createOnly) throws Exception {
        if (!a.has("content") && !createOnly) {
            throw new BridgeException("INVALID_ARGUMENT", "content is required.", null);
        }
        JSONObject b = new JSONObject().put("path", path).put("content", a.optString("content", "")).put("create_only", createOnly);
        JSONObject w = fs("write", b);
        return new JSONObject().put("path", w.getString("path")).put("size", w.optLong("size", 0)).put("created", w.optBoolean("created", false));
    }

    private JSONArray searchFiles(String query) throws Exception {
        if (query == null || query.length() < 2) {
            return new JSONArray();
        }
        JSONObject r = fs("search", new JSONObject().put("query", query).put("max_results", 50));
        JSONArray res = r.optJSONArray("results");
        return res == null ? new JSONArray() : res;
    }

    // ---------------------------------------------------------------- terminal
    private JSONObject runCommand(String command, boolean confirmed, long timeoutMs) throws Exception {
        final String project = project();
        String trimmed = command == null ? "" : command.trim();
        if (trimmed.length() == 0) {
            return new JSONObject().put("stdout", "").put("stderr", "").put("exitCode", 0).put("status", "SUCCESS");
        }
        if ("help".equals(trimmed)) {
            return new JSONObject().put("stdout", CommandPolicy.helpText()).put("stderr", "").put("exitCode", 0).put("status", "SUCCESS");
        }
        String why = CommandPolicy.check(trimmed);
        if (why != null) {
            throw new BridgeException("COMMAND_NOT_ALLOWED", why, null);
        }
        if (timeoutMs < 0 || timeoutMs > 6L * 60 * 60 * 1000) {
            throw new BridgeException("INVALID_ARGUMENT", "Invalid timeout.", null);
        }
        termux.ensureDaemon(true);
        final Coalescer co = new Coalescer();
        JSONObject r;
        try {
            r = termux.exec(project, trimmed, confirmed, timeoutMs, new TermuxBackend.StreamListener() {
                public void onOutput(String p, String commandId, String chunk) {
                    co.add(p, commandId, chunk);
                }
            });
        } finally {
            co.flush();
        }
        return r;
    }

    /** Batches streamed output so the WebView is not flooded with one evaluateJavascript per chunk. */
    private final class Coalescer {
        private final StringBuilder buf = new StringBuilder();
        private long last = 0;
        private String project = "";
        private String cmd = "";

        synchronized void add(String p, String commandId, String chunk) {
            project = p;
            cmd = commandId;
            buf.append(chunk);
            long now = System.currentTimeMillis();
            if (buf.length() > 8192 || now - last > 60) {
                flush();
            }
        }

        synchronized void flush() {
            if (buf.length() == 0) {
                return;
            }
            try {
                emit("terminal", new JSONObject().put("project", project).put("commandId", cmd).put("chunk", buf.toString()));
            } catch (Exception ignored) {
            }
            buf.setLength(0);
            last = System.currentTimeMillis();
        }
    }

    // --------------------------------------------------------------------- git
    private JSONArray gitLog() throws Exception {
        JSONArray log = TermuxBackend.dataArray(termux.postSlow("/v1/git/log", body(project(), new JSONObject().put("limit", 20)), 30000));
        return log;
    }

    private Object gitOp(JSONObject a) throws Exception {
        String op = a.optString("op", "");
        if (!GIT_OPS.contains(op)) {
            throw new BridgeException("COMMAND_NOT_ALLOWED", "That git operation is not available.", null);
        }
        JSONObject args = a.optJSONObject("args");
        JSONObject b = args == null ? new JSONObject() : args;
        String path = "/v1/git/" + op;
        if ("clone".equals(op)) {
            termux.ensureDaemon(true);
            return TermuxBackend.data(termux.postSlow(path, body(null, b), 660000));
        }
        termux.ensureDaemon(true);
        return TermuxBackend.data(termux.postSlow(path, body(project(), b), 150000));
    }

    // ------------------------------------------------------------------- agent (official OpenCode server)
    /**
     * Every chat message goes to the OpenCode agent through the OpenCode server. There is no direct model-provider call
     * in this path (the old daemon agent gateway, /v1/agent/*, is no longer reachable from the bridge).
     * In "follow the open project" mode a snapshot is taken first (best effort) so the whole task can be undone.
     */
    private JSONObject agentSend(JSONObject a) throws Exception {
        String sid = a.optString("sessionId", "");
        String snapshot = null;
        String snapshotNote = null;
        if (OpenCodeServer.MODE_PROJECT.equals(oc.server.workspaceMode()) && activeProject != null) {
            try {
                snapshot = daemon("/v1/snapshots/create", project(), new JSONObject().put("label", "Before OpenCode task").put("good", false)).optString("id", null);
            } catch (BridgeException e) {
                snapshotNote = "No undo snapshot was taken: " + e.getMessage();
            }
        } else {
            snapshotNote = "Undo snapshots are only available when OpenCode follows the open project (Settings > OpenCode > Workspace).";
        }
        String mode = a.optString("mode", "build");
        if (mode.length() == 0) {
            mode = "build";
        }
        JSONObject r = oc.agent.send(sid, a.optString("message", ""), mode);
        OpenCodeAgent.Task t = oc.agent.task(sid);
        if (t != null) {
            t.snapshot = snapshot;
        }
        return r.put("mode", mode).put("snapshot", snapshot == null ? JSONObject.NULL : snapshot)
                .put("snapshotNote", snapshotNote == null ? JSONObject.NULL : snapshotNote);
    }

    private JSONObject ocStatus() throws Exception {
        return oc.server.status().toJson(oc.server.activeTasks());
    }

    private JSONObject ocDiagnostics() throws Exception {
        JSONArray lines = new JSONArray();
        for (String l : oc.server.diagnostics()) {
            lines.put(l);
        }
        return new JSONObject().put("status", ocStatus()).put("lines", lines);
    }

    private JSONObject ocWorkspace() throws Exception {
        JSONObject o = new JSONObject().put("mode", oc.server.workspaceMode()).put("custom", providerPrefsOc().getString(OpenCodeServer.K_WS, OpenCodeServer.DEFAULT_WORKSPACE))
                .put("default", OpenCodeServer.DEFAULT_WORKSPACE);
        try {
            o.put("effective", oc.server.workspace());
        } catch (BridgeException e) {
            o.put("effective", JSONObject.NULL).put("problem", e.getMessage());
        }
        return o;
    }

    private SharedPreferences providerPrefsOc() {
        return activity.getSharedPreferences("opencode_si_oc", Context.MODE_PRIVATE);
    }

    private JSONObject ocSetWorkspace(String mode, String path) throws Exception {
        if (!OpenCodeServer.MODE_CUSTOM.equals(mode) && !OpenCodeServer.MODE_PROJECT.equals(mode)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown workspace mode.", null);
        }
        if (OpenCodeServer.MODE_CUSTOM.equals(mode)) {
            String valid = OpenCodeServer.validateWorkspace(path);       // rejects traversal, odd characters, folders outside shared storage / Termux home
            providerPrefsOc().edit().putString(OpenCodeServer.K_WS, valid).commit();
        }
        providerPrefsOc().edit().putString(OpenCodeServer.K_MODE, mode).commit();
        return ocWorkspace();
    }

    // ---- folder picker / settings shortcuts
    private void pickFolder() {
        activity.runOnUiThread(new Runnable() {
            public void run() {
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT_TREE);
                activity.startActivityForResult(i, MainActivity.REQ_FOLDER);
            }
        });
    }

    private void pickProjectFolder() {
        activity.runOnUiThread(new Runnable() {
            public void run() {
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.putExtra("android.content.extra.SHOW_ADVANCED", true);
                activity.startActivityForResult(i, MainActivity.REQ_PROJECT_FOLDER);
            }
        });
    }

    void onProjectFolderPicked(android.net.Uri uri) {
        try {
            String id = uri == null ? null : android.provider.DocumentsContract.getTreeDocumentId(uri);
            String path = folderFromTreeDocId(id);
            if (path == null) {
                emit("project.location.picked", new JSONObject().put("error", "Choose a folder on the phone's internal storage."));
                return;
            }
            emit("project.location.picked", new JSONObject().put("path", OpenCodeServer.validateWorkspace(path)));
        } catch (Exception e) {
            try { emit("project.location.picked", new JSONObject().put("error", e.getMessage() == null ? "Could not use that folder." : e.getMessage())); }
            catch (Exception ignored) {}
        }
    }

    /** SAF tree URI of the form content://com.android.externalstorage.documents/tree/primary:Download/x -> /storage/emulated/0/Download/x. */
    static String folderFromTreeDocId(String docId) {
        if (docId == null) {
            return null;
        }
        int c = docId.indexOf(':');
        if (c <= 0 || !"primary".equals(docId.substring(0, c))) {
            return null;                                                // SD cards / other providers cannot be mapped to a path Termux can use
        }
        String rel = docId.substring(c + 1);
        return "/storage/emulated/0" + (rel.length() == 0 ? "" : "/" + rel);
    }

    void onFolderPicked(android.net.Uri uri) {
        try {
            String id = uri == null ? null : android.provider.DocumentsContract.getTreeDocumentId(uri);
            String path = folderFromTreeDocId(id);
            if (path == null) {
                emit("workspace.picked", new JSONObject().put("error", "Only folders on the phone's internal storage can be used. Pick a folder under Download or Documents."));
                return;
            }
            emit("workspace.picked", new JSONObject().put("path", OpenCodeServer.validateWorkspace(path)));
        } catch (BridgeException e) {
            try {
                emit("workspace.picked", new JSONObject().put("error", e.getMessage()));
            } catch (Exception ignored) {
            }
        } catch (Exception ignored) {
        }
    }

    /** Opens only the app's fixed support destinations; arbitrary URLs from the WebView are never accepted. */
    private void openSupportLink(String destination, String subject, String body) throws BridgeException {
        final android.content.Intent intent;
        if ("github".equals(destination)) {
            intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setData(android.net.Uri.parse("https://github.com/lokeshkaradekar"));
        } else if ("termux".equals(destination)) {
            intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setData(android.net.Uri.parse("https://f-droid.org/packages/com.termux/"));
        } else if ("email".equals(destination) || "feedback".equals(destination)) {
            String safeSubject = subject == null ? "" : subject.replace("\r", " ").replace("\n", " ");
            if (safeSubject.length() > 120) safeSubject = safeSubject.substring(0, 120);
            String safeBody = body == null ? "" : body;
            if (safeBody.length() > 5000) safeBody = safeBody.substring(0, 5000);
            String uri = "mailto:lokeshkaradekar7@gmail.com";
            if ("feedback".equals(destination)) {
                try {
                    uri += "?subject=" + java.net.URLEncoder.encode(safeSubject.length() == 0 ? "OpenCode SI feedback" : safeSubject, "UTF-8")
                            + "&body=" + java.net.URLEncoder.encode(safeBody, "UTF-8");
                } catch (java.io.UnsupportedEncodingException ignored) { }
            }
            intent = new android.content.Intent(android.content.Intent.ACTION_SENDTO);
            intent.setData(android.net.Uri.parse(uri));
        } else {
            throw new BridgeException("INVALID_DESTINATION", "This support destination is not allowed.", null);
        }
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
        } catch (Exception e) {
            throw new BridgeException("SUPPORT_APP_UNAVAILABLE", "No compatible app was found to open this support link.", e.getClass().getSimpleName());
        }
    }

    private JSONObject copyText(String value) throws Exception {
        if (value == null || value.length() > 4000) throw new BridgeException("INVALID_ARGUMENT", "Text to copy is too long.", null);
        android.content.ClipboardManager cm = (android.content.ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) throw new BridgeException("CLIPBOARD_UNAVAILABLE", "Android clipboard is not available on this device.", null);
        cm.setPrimaryClip(android.content.ClipData.newPlainText("OpenCode SI setup", value));
        return new JSONObject().put("copied", true);
    }

    private void openAppSettings() {
        activity.runOnUiThread(new Runnable() {
            public void run() {
                android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i.setData(android.net.Uri.parse("package:" + activity.getPackageName()));
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(i);
            }
        });
    }

    private void openTermux() throws BridgeException {
        final android.content.Intent i = termux.termuxLaunchIntent();
        if (i == null) {
            throw new BridgeException("BACKEND_UNAVAILABLE", "Termux is not installed.", null);
        }
        activity.runOnUiThread(new Runnable() {
            public void run() {
                activity.startActivity(i);
            }
        });
    }

    /** Activity came back to the foreground: re-check the server without blocking the UI and without starting anything. */
    void onActivityResumed() {
        try {
            pool.submit(new Runnable() {
                public void run() {
                    OpenCodeServer.Status before = oc.server.status();
                    OpenCodeServer.Status now = oc.server.recheck();
                    // Server vanished while we were away: controlled recovery (one bounded attempt, cool-down applies).
                    if (before.state == OpenCodeServer.State.READY && now.state == OpenCodeServer.State.SERVER_STOPPED) {
                        oc.server.ensureReady(true, false);
                    }
                }
            });
        } catch (RuntimeException ignored) {
        }
    }

    // --------------------------------------------------------------- providers
    private SharedPreferences providerPrefs() {
        return activity.getSharedPreferences("opencode_si_providers", Context.MODE_PRIVATE);
    }

    private static String defaultBase(String id) {
        if ("hosted".equals(id)) {
            return "https://openrouter.ai/api/v1";
        }
        if ("local".equals(id)) {
            return "http://127.0.0.1:11434/v1";        // Ollama / llama.cpp server running in Termux
        }
        return "";
    }

    private JSONObject providerConfig(String id) throws Exception {
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        SharedPreferences p = providerPrefs();
        return new JSONObject().put("id", id).put("baseUrl", p.getString(id + ".base_url", defaultBase(id)))
                .put("model", p.getString(id + ".model", "")).put("needsKey", !"local".equals(id))
                .put("hasKey", secrets.has(secretId(id)));
    }

    private JSONObject setProviderConfig(JSONObject a) throws Exception {
        String id = a.optString("id", "");
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        String base = a.optString("baseUrl", "").trim();
        String model = a.optString("model", "").trim();
        if (base.length() > 0 && !(base.startsWith("https://") || base.startsWith("http://"))) {
            throw new BridgeException("INVALID_ARGUMENT", "The URL must start with https:// (or http:// for a server on this device or LAN).", null);
        }
        if (base.length() > 300 || model.length() > 200) {
            throw new BridgeException("INVALID_ARGUMENT", "The URL or model name is too long.", null);
        }
        if (base.length() > 0) {
            try {
                java.net.URI u = new java.net.URI(base);
                if (u.getHost() == null || u.getUserInfo() != null) {
                    throw new BridgeException("INVALID_ARGUMENT", "Enter a URL like https://host/v1 (credentials in the URL are not allowed).", null);
                }
            } catch (java.net.URISyntaxException e) {
                throw new BridgeException("INVALID_ARGUMENT", "That is not a valid URL.", null);
            }
        }
        providerPrefs().edit().putString(id + ".base_url", base).putString(id + ".model", model).commit();
        return providerConfig(id);
    }

    /** Builds the provider block for the daemon. The key is read here, in Java, and only travels over loopback. */
    private JSONObject providerForDaemon(String id) throws Exception {
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        SharedPreferences p = providerPrefs();
        JSONObject o = new JSONObject().put("base_url", p.getString(id + ".base_url", defaultBase(id)))
                .put("model", p.getString(id + ".model", "")).put("needs_key", !"local".equals(id));
        String key = secrets.get(secretId(id));
        if (key != null) {
            o.put("api_key", key);
        }
        return o;
    }

    private JSONObject providerHealth(String id) throws Exception {
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        try {
            termux.ensureDaemon(true);
        } catch (BridgeException e) {
            return new JSONObject().put("status", "failed").put("detail", "Cannot check: the Termux daemon is not reachable").put("raw", e.code);
        }
        return TermuxBackend.data(termux.postSlow("/v1/agent/probe", new JSONObject().put("provider", providerForDaemon(id)), 40000));
    }

    private JSONArray listModels(String id) throws Exception {
        if (!PROVIDERS.contains(id)) {
            throw new BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
        }
        termux.ensureDaemon(true);
        JSONArray m = TermuxBackend.dataArray(termux.postSlow("/v1/agent/models", new JSONObject().put("provider", providerForDaemon(id)), 40000));
        return m;
    }

    // ------------------------------------------------------------- environment
    private long freeMb() {
        StatFs fs = new StatFs(activity.getFilesDir().getPath());
        return fs.getAvailableBytes() / (1024 * 1024);
    }

    private JSONObject environment() throws Exception {
        String arch = Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "unknown";
        JSONObject env = new JSONObject().put("backend", "local").put("bridge", APP_VERSION)
                .put("android", new JSONObject().put("version", Build.VERSION.RELEASE).put("api", Build.VERSION.SDK_INT))
                .put("arch", arch).put("termux", termux.termuxVersion() == null ? JSONObject.NULL : termux.termuxVersion())
                .put("shell", "bash").put("workspace", WORKSPACE_DISPLAY).put("storageFreeMB", freeMb());
        try {
            JSONObject ping = termux.ping();
            env.put("daemon", ping.optString("daemon")).put("pty", true).put("workspaceAbsolute", ping.optString("workspace"));
        } catch (BridgeException e) {
            env.put("daemon", JSONObject.NULL).put("pty", false).put("daemonError", e.code);
        }
        return env;
    }

    private JSONObject daemonStatus() throws Exception {
        JSONObject s = new JSONObject().put("port", termux.port()).put("termuxInstalled", termux.termuxInstalled())
                .put("runCommandPermission", termux.hasRunCommandPermission());
        try {
            JSONObject ping = termux.ping();
            s.put("reachable", true).put("authenticated", true).put("version", ping.optString("daemon")).put("workspace", ping.optString("workspace"));
        } catch (BridgeException e) {
            s.put("reachable", !"DAEMON_UNREACHABLE".equals(e.code) && !"DAEMON_TIMEOUT".equals(e.code))
                    .put("authenticated", false).put("error", e.code).put("message", e.getMessage());
        }
        return s;
    }

    private void requestPermission() throws BridgeException {
        if (!termux.termuxInstalled()) {
            throw new BridgeException("BACKEND_UNAVAILABLE", "Termux is not installed.", null);
        }
        if (Build.VERSION.SDK_INT < 23) {
            return;
        }
        activity.runOnUiThread(new Runnable() {
            public void run() {
                activity.requestPermissions(new String[]{TermuxBackend.PERM_RUN_COMMAND}, MainActivity.REQ_TERMUX);
            }
        });
    }

    private static JSONObject check(String key, String name, String status, String detail, String raw) throws Exception {
        return new JSONObject().put("key", key).put("name", name).put("status", status).put("detail", detail).put("raw", raw == null ? JSONObject.NULL : raw);
    }

    /** Every check reflects a real probe. If the daemon cannot be reached the overall status cannot be "ok". */
    private JSONObject healthCheck() throws Exception {
        JSONArray checks = new JSONArray();
        checks.put(check("bridge", "Android bridge", "ok", "Native bridge " + APP_VERSION + ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")", null));
        boolean installed = termux.termuxInstalled();
        checks.put(check("termux_app", "Termux app", installed ? "ok" : "failed", installed ? "Termux " + termux.termuxVersion() : "Termux is not installed",
                installed ? null : "package com.termux not found"));
        boolean perm = termux.hasRunCommandPermission();
        checks.put(check("permission", "Termux access", perm ? "ok" : "warning", perm ? "RUN_COMMAND granted" : "RUN_COMMAND not granted (needed only to auto-start the daemon)",
                perm ? null : "PERMISSION_DENIED: " + TermuxBackend.PERM_RUN_COMMAND));
        JSONObject ping = null;
        try {
            ping = termux.ping();
            checks.put(check("daemon", "Termux daemon", "ok", "ocd " + ping.optString("daemon") + " on 127.0.0.1:" + termux.port(), null));
            checks.put(check("auth", "Daemon authentication", "ok", "Token accepted", null));
        } catch (BridgeException e) {
            boolean auth = "DAEMON_AUTH_FAILED".equals(e.code);
            checks.put(check("daemon", "Termux daemon", auth ? "ok" : "failed", auth ? "Daemon is running" : e.getMessage(), auth ? null : e.code + (e.details == null ? "" : ": " + e.details)));
            checks.put(check("auth", "Daemon authentication", auth ? "failed" : "failed", auth ? e.getMessage() : "Not checked: daemon unreachable", e.code));
        }
        if (ping != null) {
            try {
                JSONObject h = TermuxBackend.data(termux.call("GET", "/v1/health", null, 40000));
                JSONArray dc = h.optJSONArray("checks");
                for (int i = 0; dc != null && i < dc.length(); i++) {
                    JSONObject c = dc.getJSONObject(i);
                    if ("termux".equals(c.optString("key"))) {
                        c.put("key", "termux_env").put("name", "Termux environment");
                    }
                    checks.put(c);
                }
            } catch (BridgeException e) {
                checks.put(check("daemon_health", "Daemon health", "failed", e.getMessage(), e.code));
            }
        } else {
            long mb = freeMb();
            checks.put(check("storage_app", "App storage", mb < 200 ? "failed" : "ok", mb + " MB free", mb < 200 ? "ENOSPC: only " + mb + " MB free" : null));
        }
        OpenCodeServer.Status os = oc.server.status();
        String ost = os.state == OpenCodeServer.State.READY ? "ok"
                : (os.state == OpenCodeServer.State.CONNECTION_FAILED || os.state == OpenCodeServer.State.AUTHENTICATION_FAILED || os.state == OpenCodeServer.State.NOT_CONFIGURED) ? "failed" : "warning";
        checks.put(check("opencode_server", "OpenCode server", ost, os.message == null ? os.state.name() : os.message,
                os.state == OpenCodeServer.State.READY ? null : os.state.name() + (os.code == null ? "" : " [" + os.code + "]") + (os.detail == null ? "" : ": " + os.detail)));
        String status = "ok";
        for (int i = 0; i < checks.length(); i++) {
            String s = checks.getJSONObject(i).getString("status");
            if ("failed".equals(s)) {
                status = "failed";
                break;
            }
            if ("warning".equals(s)) {
                status = "warning";
            }
        }
        return new JSONObject().put("status", status).put("checks", checks);
    }

    // ---------------------------------------------------------------- recovery
    private JSONObject repair(int level) throws Exception {
        switch (level) {
            case 0: {
                JSONObject ping = termux.ensureDaemon(false);
                return new JSONObject().put("note", "Daemon answered (ocd " + ping.optString("daemon") + ").");
            }
            case 1: {
                try {
                    termux.ping();
                } catch (BridgeException e) {
                    if ("DAEMON_UNREACHABLE".equals(e.code)) {
                        termux.ensureDaemon(true);
                        return new JSONObject().put("note", "Started the Termux daemon.");
                    }
                    throw e;
                }
                termux.restartSession(project());
                return new JSONObject().put("note", "Restarted the terminal shell (working folder kept).");
            }
            case 2: {
                termux.ensureDaemon(true);
                JSONObject r = TermuxBackend.data(termux.post("/v1/maintenance/cleanup", new JSONObject()));
                return new JSONObject().put("note", "Removed " + r.optInt("tmp_files", 0) + " stale temp file(s) and " + r.optInt("old_agent_sessions", 0) + " old agent session(s).");
            }
            case 3:
            case 4:
                throw new BridgeException("NOT_IMPLEMENTED", "This build has no dependency or runtime switching. Fix it from Termux (pkg upgrade / pkg install nodejs).", null);
            default:
                throw new BridgeException("NOT_IMPLEMENTED", "Recovery level " + level + " is handled by the app UI or is not available.", null);
        }
    }

    private JSONObject setBackend(String name) throws Exception {
        if ("local".equals(name)) {
            return new JSONObject().put("backend", "local");
        }
        throw new BridgeException("NOT_IMPLEMENTED", "A remote workspace is not implemented. Only the local Termux backend exists.", null);
    }

    // ================================================================ command policy
    /**
     * Command allowlist for the terminal. This is a SAFETY RAIL, not a sandbox: node, python, npx and similar can
     * run arbitrary code by design. Its job is to (1) keep the terminal to developer tools, (2) make it impossible
     * to smuggle a second command in through $( ), backticks, subshells or heredocs, and (3) refuse git global
     * options that can execute code. The daemon applies its own destructive-command Policy on top (rm, reset --hard,
     * force-push... need confirmation; fork bombs and raw block-device writes are denied outright).
     */
    static final class CommandPolicy {
        static final Set<String> BUILTINS = new HashSet<String>(Arrays.asList(
                "cd", "pwd", "echo", "export", "unset", "test", "[", "true", "false", ":", "clear", "printf", "read"));
        static final Set<String> ALLOWED = new HashSet<String>(Arrays.asList(
                "ls", "cat", "head", "tail", "wc", "grep", "egrep", "find", "sort", "uniq", "diff", "cmp", "touch", "mkdir",
                "cp", "mv", "rm", "rmdir", "ln", "stat", "file", "du", "df", "tree", "basename", "dirname", "realpath",
                "sleep", "which", "type", "uname", "whoami", "date", "printenv", "sed", "awk", "tr", "cut", "tee", "chmod",
                "node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pip", "pip3", "git", "tsc", "curl", "make"));
        static final Set<String> GIT_SUB = new HashSet<String>(Arrays.asList(
                "status", "diff", "log", "branch", "checkout", "commit", "pull", "push", "fetch", "stash", "add", "restore",
                "clone", "rev-parse", "init", "show", "remote", "tag", "merge", "reset", "rm", "mv", "switch"));
        static final Set<String> BLOCKED_ENV = new HashSet<String>(Arrays.asList(
                "PATH", "IFS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_COUNT"));
        private static final Pattern ASSIGN = Pattern.compile("^([A-Za-z_][A-Za-z0-9_]*)=.*$", Pattern.DOTALL);

        static String helpText() {
            List<String> all = new ArrayList<String>(ALLOWED);
            all.addAll(BUILTINS);
            java.util.Collections.sort(all);
            StringBuilder sb = new StringBuilder("Real shell in your project folder (state such as cd persists).\nAllowed commands:\n");
            for (String s : all) {
                sb.append(s).append(' ');
            }
            sb.append("\nNot allowed: $(...), `...`, ( ), <<, other programs. Risky commands (rm, reset --hard, force-push) ask for review first.\n");
            return sb.toString();
        }

        /** Returns null if the command is acceptable, otherwise a user-readable reason. */
        static String check(String cmd) {
            if (cmd == null || cmd.length() == 0) {
                return null;
            }
            if (cmd.length() > 8000) {
                return "The command is too long.";
            }
            if (cmd.indexOf('\0') >= 0) {
                return "Invalid character in command.";
            }
            List<String> segments = new ArrayList<String>();
            StringBuilder cur = new StringBuilder();
            char quote = 0;
            int n = cmd.length();
            for (int i = 0; i < n; i++) {
                char c = cmd.charAt(i);
                char next = i + 1 < n ? cmd.charAt(i + 1) : 0;
                if (quote == '\'') {
                    if (c == '\'') {
                        quote = 0;
                    }
                    cur.append(c);
                    continue;
                }
                if (quote == '"') {
                    if (c == '\\' && i + 1 < n) {
                        cur.append(c).append(next);
                        i++;
                        continue;
                    }
                    if (c == '`' || (c == '$' && next == '(')) {
                        return "Command substitution ($(...) or backticks) is not allowed.";
                    }
                    if (c == '"') {
                        quote = 0;
                    }
                    cur.append(c);
                    continue;
                }
                if (c == '\\' && i + 1 < n) {
                    cur.append(c).append(next);
                    i++;
                    continue;
                }
                if (c == '\'' || c == '"') {
                    quote = c;
                    cur.append(c);
                    continue;
                }
                if (c == '`' || (c == '$' && next == '(')) {
                    return "Command substitution ($(...) or backticks) is not allowed.";
                }
                if (c == '(' || c == ')') {
                    return "Subshells and ( ) grouping are not allowed.";
                }
                if (c == '<' && next == '<') {
                    return "Here-documents are not allowed. Write the file with the editor instead.";
                }
                if (c == '\n' || c == '\r' || c == ';' || c == '|') {
                    segments.add(cur.toString());
                    cur.setLength(0);
                    continue;
                }
                if (c == '&') {
                    char prev = i > 0 ? cmd.charAt(i - 1) : 0;
                    if (prev == '>' || prev == '<' || next == '>') {
                        cur.append(c);                    // 2>&1 and &> are redirections, not separators
                        continue;
                    }
                    segments.add(cur.toString());
                    cur.setLength(0);
                    continue;
                }
                cur.append(c);
            }
            if (quote != 0) {
                return "Unterminated quote.";
            }
            segments.add(cur.toString());
            for (String seg : segments) {
                String why = checkSegment(seg.trim());
                if (why != null) {
                    return why;
                }
            }
            return null;
        }

        private static String checkSegment(String seg) {
            if (seg.length() == 0) {
                return null;
            }
            List<String> toks = tokenize(seg);
            int i = 0;
            while (i < toks.size()) {
                java.util.regex.Matcher m = ASSIGN.matcher(toks.get(i));
                if (!m.matches()) {
                    break;
                }
                String name = m.group(1);
                if (BLOCKED_ENV.contains(name) || name.startsWith("LD_") || name.startsWith("DYLD_") || name.startsWith("GIT_CONFIG")) {
                    return "Setting " + name + " is not allowed.";
                }
                i++;
            }
            if (i >= toks.size()) {
                return null;                              // only assignments
            }
            String first = toks.get(i);
            if (first.startsWith(">") || first.startsWith("<") || first.matches("^[0-9]+[<>].*")) {
                return null;                              // leading redirection, e.g. "> file"
            }
            if (first.indexOf('/') >= 0) {
                if (!first.startsWith("./node_modules/.bin/") || first.contains("..")) {
                    return "Run programs by name (for example node or npm), not by path.";
                }
            } else if (!ALLOWED.contains(first) && !BUILTINS.contains(first)) {
                return "\"" + first + "\" is not on the allowed command list. Type help to see it.";
            }
            if ("git".equals(first)) {
                if (i + 1 < toks.size()) {
                    String sub = toks.get(i + 1);
                    if (sub.startsWith("-") && !sub.equals("--version")) {
                        return "git options before the sub-command (such as -c or -C) are not allowed.";
                    }
                    if (!sub.equals("--version") && !GIT_SUB.contains(sub)) {
                        return "That git command is not allowed.";
                    }
                }
            }
            if ("find".equals(first)) {
                for (int k = i + 1; k < toks.size(); k++) {
                    String t = toks.get(k);
                    if (t.equals("-exec") || t.equals("-execdir") || t.equals("-ok") || t.equals("-okdir") || t.equals("-delete")) {
                        return "find " + t + " is not allowed. Use rm / a script instead.";
                    }
                }
            }
            return null;
        }

        /** Whitespace tokenizer that honours quotes and returns tokens with the quotes removed. */
        static List<String> tokenize(String s) {
            List<String> out = new ArrayList<String>();
            StringBuilder cur = new StringBuilder();
            boolean any = false;
            char quote = 0;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (quote != 0) {
                    if (c == quote) {
                        quote = 0;
                    } else if (c == '\\' && quote == '"' && i + 1 < s.length()) {
                        cur.append(s.charAt(++i));
                    } else {
                        cur.append(c);
                    }
                } else if (c == '\'' || c == '"') {
                    quote = c;
                    any = true;
                } else if (c == '\\' && i + 1 < s.length()) {
                    cur.append(s.charAt(++i));
                    any = true;
                } else if (Character.isWhitespace(c)) {
                    if (any || cur.length() > 0) {
                        out.add(cur.toString());
                        cur.setLength(0);
                        any = false;
                    }
                } else {
                    cur.append(c);
                    any = true;
                }
            }
            if (any || cur.length() > 0) {
                out.add(cur.toString());
            }
            return out;
        }
    }
}
