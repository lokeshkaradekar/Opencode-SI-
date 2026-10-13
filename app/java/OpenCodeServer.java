package com.opencode.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Lifecycle manager for the OFFICIAL OpenCode server (`opencode serve`) that runs inside Termux.
 *
 *   UI -> NativeBridge -> OpenCodeServer.ensureReady() -> [health probe] -> (not running) -> Termux RUN_COMMAND (background)
 *                                                      -> poll /global/health with bounded backoff -> READY
 *
 * Rules this class enforces (each one has a test in OpenCodeServerTest):
 *  - READY is only ever set from a real, successful health probe. An accepted Android intent is NOT success.
 *  - One startup at a time per process: concurrent callers (resume, activity recreation, several messages) join the
 *    same in-flight operation instead of launching a second server.
 *  - At most ONE launch per ensureReady call, then a bounded wait. No endless loop; after a failure, automatic
 *    callers are held off for a cool-down (an explicit user retry is not).
 *  - A healthy server is reused. It is attached to only if it runs in the wanted workspace; a foreign process on the
 *    port is reported (PORT_CONFLICT) and never killed.
 *  - We only stop a server we started, and the stop script re-verifies the pid file against /proc/<pid>/cmdline.
 *
 * Android-facing pieces (Termux, prefs, SecureStore, events) are behind {@link Host} so this class runs in plain-Java tests.
 */
final class OpenCodeServer {
    enum State {
        NOT_CONFIGURED, CHECKING_TERMUX, CHECKING_SERVER, STARTING_SERVER, WAITING_FOR_HEALTH, READY,
        CONNECTION_FAILED, AUTHENTICATION_FAILED, SERVER_STOPPED, RESTARTING, STOPPING
    }

    static final int DEFAULT_PORT = 4096;
    static final String DEFAULT_WORKSPACE = "/storage/emulated/0/Download/opencode-si";
    static final String TESTED_VERSION = "1.18.33-termux";
    static final String TERMUX_HOME = "/data/data/com.termux/files/home";
    static final String MODE_CUSTOM = "custom";
    static final String MODE_PROJECT = "project";
    private static final Pattern WS_RE = Pattern.compile("^/[A-Za-z0-9._ @+=,()\\-/]{1,400}$");

    // pref keys (stored through Host.pref; never secrets)
    static final String K_PORT = "oc.port";
    static final String K_WS = "oc.workspace";
    static final String K_MODE = "oc.workspace.mode";
    static final String K_MANAGED = "oc.managed";
    static final String K_MANAGED_PORT = "oc.managed.port";
    static final String K_MANAGED_WS = "oc.managed.workspace";
    static final String K_MANAGED_AT = "oc.managed.started";
    static final String K_SETUP_DONE = "oc.setup.done";

    /** What Termux reported for a script. delivered=false means Android/Termux gave no result (not the same as failure). */
    static final class ScriptResult {
        final boolean delivered;
        final int exitCode;
        final String stdout;
        final String stderr;
        final String error;

        ScriptResult(boolean delivered, int exitCode, String stdout, String stderr, String error) {
            this.delivered = delivered;
            this.exitCode = exitCode;
            this.stdout = stdout == null ? "" : stdout;
            this.stderr = stderr == null ? "" : stderr;
            this.error = error;
        }
    }

    interface Host {
        boolean termuxInstalled();

        boolean runCommandPermission();

        /** Runs a bash script in Termux in the background and waits (bounded) for its result. Throws BridgeException when Android/Termux refuses. */
        ScriptResult runScript(String script, String[] args, long timeoutMs) throws NativeBridge.BridgeException;

        String pref(String key, String def);

        void setPref(String key, String value);

        /** App-owned server password (SecureStore), created on first use. Never logged. */
        String serverPassword() throws NativeBridge.BridgeException;

        /** Absolute Termux path of the app's currently open project, or null if none is open. */
        String activeProjectDir();

        void publish(Status s);
    }

    interface ClientFactory {
        OpenCodeClient create(int port, String password);
    }

    static final class Settings {
        long startupTimeoutMs = 60000;
        long pollMinMs = 400;
        long pollMaxMs = 2000;
        long cooldownMs = 8000;
        long launchTimeoutMs = 20000;
        // How long a run with no visible progress is watched after a dropped connection, before the outcome is
        // reported as UNCERTAIN. A single step (e.g. a long `npm test` or install) can legitimately run for
        // minutes with the step log showing no change the entire time - the daemon runs commands with no
        // step-level timeout by default (daemon/ocd.py exec(): timeout_ms=0 means unbounded). 30s was too tight
        // and turned ordinary long-running commands into false UNCERTAIN results after any brief connection blip.
        long idleWindowMs = 180000;
    }

    /** Immutable snapshot of the lifecycle for the UI. */
    static final class Status {
        final State state;
        final String code;
        final String message;
        final String detail;
        final boolean managed;
        final String workspace;
        final int port;
        final String version;
        final Boolean authEnforced;
        final boolean workspaceVerified;

        Status(State state, String code, String message, String detail, boolean managed, String workspace, int port, String version, Boolean authEnforced, boolean workspaceVerified) {
            this.state = state;
            this.code = code;
            this.message = message;
            this.detail = detail;
            this.managed = managed;
            this.workspace = workspace;
            this.port = port;
            this.version = version;
            this.authEnforced = authEnforced;
            this.workspaceVerified = workspaceVerified;
        }

        boolean ready() {
            return state == State.READY;
        }

        JSONObject toJson(int activeTasks) {
            JSONObject o = new JSONObject();
            try {
                o.put("state", state.name()).put("code", code == null ? JSONObject.NULL : code).put("message", message == null ? "" : message)
                        .put("detail", detail == null ? JSONObject.NULL : detail).put("managed", managed).put("workspace", workspace == null ? JSONObject.NULL : workspace)
                        .put("port", port).put("version", version == null ? JSONObject.NULL : version)
                        .put("authEnforced", authEnforced == null ? JSONObject.NULL : authEnforced)
                        .put("workspaceVerified", workspaceVerified).put("activeTasks", activeTasks).put("testedVersion", TESTED_VERSION);
            } catch (Exception ignored) {
            }
            return o;
        }
    }

    // ---------------------------------------------------------------- scripts run INSIDE Termux (bash)
    // Arguments are passed positionally ($1...), never spliced into the script text: no quoting/injection problems.
    /** $1 workspace, $2 port, $3 password. Starts the server detached, records its pid. Exit codes: 127 no executable, 20 workspace unusable, 21 cd failed. */
    static final String START_SCRIPT =
            "PFX=\"${PREFIX:-/data/data/com.termux/files/usr}\"\n"
                    + "oc=\"$(command -v opencode 2>/dev/null)\"; [ -n \"$oc\" ] || oc=\"$PFX/bin/opencode\"\n"
                    + "[ -x \"$oc\" ] || { echo 'OPENCODE_NOT_FOUND' >&2; exit 127; }\n"
                    // OpenCode 1.18.x installations may omit the Plan agent from their configuration. Install a
                    // conservative global primary agent only when the user has not already supplied one. The
                    // agent can read/plan, cannot edit project files, and asks before shell execution.
                    + "agentdir=\"$HOME/.config/opencode/agents\"; planfile=\"$agentdir/plan.md\"; mkdir -p \"$agentdir\"\n"
                    + "if [ ! -e \"$planfile\" ]; then tmp=\"$planfile.tmp.$$\"; cat > \"$tmp\" <<'OCSI_PLAN_AGENT'\n"
                    + "---\n"
                    + "description: Read-only planning agent for OpenCode SI\n"
                    + "mode: primary\n"
                    + "permission:\n"
                    + "  edit: deny\n"
                    + "  bash: ask\n"
                    + "  external_directory: deny\n"
                    + "---\n"
                    + "You are the Plan agent in OpenCode SI. Analyze the user's request and the current project. Produce a clear, ordered implementation plan, note risks and tests, and ask questions when requirements are ambiguous. Do not modify project files. Do not claim to have executed commands or changed files. Shell commands require explicit approval.\n"
                    + "OCSI_PLAN_AGENT\n"
                    + "mv -- \"$tmp\" \"$planfile\"; fi\n"
                    + "ws=\"$1\"\n"
                    + "{ [ -d \"$ws\" ] && [ -r \"$ws\" ] && [ -w \"$ws\" ]; } || { echo \"WORKSPACE_INACCESSIBLE: $ws\" >&2; exit 20; }\n"
                    + "cd \"$ws\" || { echo 'CD_FAILED' >&2; exit 21; }\n"
                    + "sd=\"$HOME/.opencode-si\"; mkdir -p \"$sd\"; rm -f \"$sd/opencode-server.pid\"\n"
                    + "if command -v setsid >/dev/null 2>&1; then grp=group; OPENCODE_SERVER_PASSWORD=\"$3\" nohup setsid \"$oc\" serve --hostname 127.0.0.1 --port \"$2\" >\"$sd/opencode-server.log\" 2>&1 </dev/null &\n"
                    + "else grp=single; OPENCODE_SERVER_PASSWORD=\"$3\" nohup \"$oc\" serve --hostname 127.0.0.1 --port \"$2\" >\"$sd/opencode-server.log\" 2>&1 </dev/null &\n"
                    + "fi\n"
                    + "pid=$!\n"
                    + "printf '%s\\n%s\\n' \"$pid\" \"$grp\" > \"$sd/opencode-server.pid\"\n"
                    + "echo \"LAUNCHED pid=$pid\"\n";

    /** $1 workspace. Read-only probe used by the setup wizard. */
    static final String PROBE_SCRIPT =
            "PFX=\"${PREFIX:-/data/data/com.termux/files/usr}\"\n"
                    + "oc=\"$(command -v opencode 2>/dev/null)\"; [ -n \"$oc\" ] || oc=\"$PFX/bin/opencode\"\n"
                    + "echo \"OC_PATH=$oc\"\n"
                    + "if [ -x \"$oc\" ]; then echo OC_EXEC=1; v=\"$(\"$oc\" --version 2>&1 | head -n 1)\"; echo \"OC_VERSION=$v\"; else echo OC_EXEC=0; fi\n"
                    + "ws=\"$1\"\n"
                    + "if [ -d \"$ws\" ] && [ -r \"$ws\" ] && [ -w \"$ws\" ]; then echo WS=ok; elif [ -d \"$ws\" ]; then echo WS=noaccess; else echo WS=missing; fi\n";

    /** $1 port. Stops ONLY the process recorded by our own start script, after re-checking /proc/<pid>/cmdline. */
    static final String STOP_SCRIPT =
            "sd=\"$HOME/.opencode-si\"; pf=\"$sd/opencode-server.pid\"\n"
                    + "[ -f \"$pf\" ] || { echo NO_PIDFILE; exit 3; }\n"
                    + "pid=\"$(sed -n 1p \"$pf\")\"; grp=\"$(sed -n 2p \"$pf\")\"\n"
                    + "case \"$pid\" in ''|*[!0-9]*) echo BAD_PIDFILE; exit 3;; esac\n"
                    + "[ -r \"/proc/$pid/cmdline\" ] || { echo NOT_RUNNING; rm -f \"$pf\"; exit 0; }\n"
                    + "cmd=\"$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")\"\n"
                    + "case \"$cmd\" in *opencode*serve*\"--port $1\"*|*opencode*serve*\"--port=$1\"*) ;; *) echo \"NOT_OURS: $cmd\"; exit 4;; esac\n"
                    + "if [ \"$grp\" = group ]; then kill -TERM -- \"-$pid\" 2>/dev/null; else kill -TERM \"$pid\" 2>/dev/null; fi\n"
                    + "i=0; while [ $i -lt 12 ] && [ -d \"/proc/$pid\" ]; do sleep 0.5; i=$((i+1)); done\n"
                    + "if [ -d \"/proc/$pid\" ]; then if [ \"$grp\" = group ]; then kill -KILL -- \"-$pid\" 2>/dev/null; else kill -KILL \"$pid\" 2>/dev/null; fi; echo KILLED; else echo STOPPED; fi\n"
                    + "rm -f \"$pf\"\n";

    /** Verifies that the live server on $1 is the exact process recorded by our launcher and is running in $2. */
    static final String OWNERSHIP_SCRIPT =
            "sd=\"$HOME/.opencode-si\"; pf=\"$sd/opencode-server.pid\"\n"
                    + "[ -r \"$pf\" ] || { echo NOT_OWNED; exit 0; }\n"
                    + "pid=\"$(sed -n 1p \"$pf\")\"; case \"$pid\" in ''|*[!0-9]*) echo NOT_OWNED; exit 0;; esac\n"
                    + "[ -r \"/proc/$pid/cmdline\" ] || { echo NOT_OWNED; exit 0; }\n"
                    + "cmd=\"$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")\"\n"
                    + "case \"$cmd\" in *opencode*serve*\"--port $1\"*|*opencode*serve*\"--port=$1\"*) ;; *) echo NOT_OWNED; exit 0;; esac\n"
                    + "cwd=\"$(readlink -f \"/proc/$pid/cwd\" 2>/dev/null)\"; want=\"$(readlink -f \"$2\" 2>/dev/null)\"\n"
                    + "[ -n \"$cwd\" ] && [ \"$cwd\" = \"$want\" ] || { echo NOT_OWNED; exit 0; }\n"
                    + "printf 'OWNED_PID=%s\\nOWNED_CWD=%s\\n' \"$pid\" \"$cwd\"\n";

    static final String LOG_SCRIPT = "tail -n 40 \"$HOME/.opencode-si/opencode-server.log\" 2>&1 || echo '(no server log yet)'\n";

    // ---------------------------------------------------------------- state
    private final Host host;
    private final ClientFactory clients;
    private final Settings cfg;
    private final Object lock = new Object();
    private final Object opLock = new Object();
    private final LinkedList<String> diag = new LinkedList<String>();
    private final AtomicInteger activeTasks = new AtomicInteger();
    private final AtomicInteger launches = new AtomicInteger();      // total launch scripts run by this process (tests assert on it)
    private volatile Status status;
    private volatile boolean everReady;
    private volatile long lastFailureAt;
    private volatile Status lastFailureStatus;
    private volatile boolean autoDisabledByFailure;
    private FutureTask<Status> inflight;
    private volatile java.util.Set<String> specCache;
    private volatile String specVersion;

    OpenCodeServer(Host host, ClientFactory clients, Settings settings) {
        this.host = host;
        this.clients = clients;
        this.cfg = settings == null ? new Settings() : settings;
        this.status = new Status(State.CHECKING_SERVER, null, "Not checked yet.", null, false, null, port(), null, null, false);
    }

    // ---------------------------------------------------------------- accessors
    Status status() {
        return status;
    }

    int activeTasks() {
        return activeTasks.get();
    }

    AtomicInteger taskCounter() {
        return activeTasks;
    }

    long idleWindowMs() {
        return cfg.idleWindowMs;
    }

    int launchCount() {
        return launches.get();
    }

    int port() {
        try {
            int p = Integer.parseInt(host.pref(K_PORT, String.valueOf(DEFAULT_PORT)));
            return p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
        } catch (NumberFormatException e) {
            return DEFAULT_PORT;
        }
    }

    String workspaceMode() {
        return MODE_PROJECT.equals(host.pref(K_MODE, MODE_CUSTOM)) ? MODE_PROJECT : MODE_CUSTOM;
    }

    /** The directory OpenCode must work in, validated. Throws WORKSPACE_INVALID instead of falling back to anything else. */
    String workspace() throws NativeBridge.BridgeException {
        String raw = MODE_PROJECT.equals(workspaceMode()) ? host.activeProjectDir() : host.pref(K_WS, DEFAULT_WORKSPACE);
        if (raw == null) {
            throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "No project is open, so there is no folder for OpenCode to work in.", null);
        }
        return validateWorkspace(raw);
    }

    /** True when the folder the user wants differs from the folder the connected server was verified/launched for. */
    boolean workspaceChanged() {
        try {
            String want = workspace();
            String have = status.workspace;
            return have == null || !normPath(have).equals(normPath(want));
        } catch (NativeBridge.BridgeException e) {
            return true;
        }
    }

    OpenCodeClient client() throws NativeBridge.BridgeException {
        return clients.create(port(), host.serverPassword());
    }

    /** Syntactic validation only (the folder's existence/permissions are verified inside Termux). No traversal, no control characters. */
    static String validateWorkspace(String path) throws NativeBridge.BridgeException {
        if (path == null) {
            throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "No folder selected.", null);
        }
        String p = path.trim();
        if (!WS_RE.matcher(p).matches() || p.indexOf("//") >= 0) {
            throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "That folder path contains characters that are not allowed.", null);
        }
        for (String seg : p.split("/")) {
            if (seg.equals("..") || seg.equals(".")) {
                throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "Folder paths may not contain . or .. segments.", null);
            }
        }
        while (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        String n = normPath(p);
        boolean shared = n.equals("/storage/emulated/0") || n.startsWith("/storage/emulated/0/");
        boolean termux = n.equals(TERMUX_HOME) || n.startsWith(TERMUX_HOME + "/");
        if (n.equals("/storage/emulated/0") || n.equals(TERMUX_HOME)) {
            throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "Pick a project folder, not the whole storage or home directory.", null);
        }
        if (!shared && !termux) {
            throw new NativeBridge.BridgeException("WORKSPACE_INVALID", "Only folders in shared storage (/storage/emulated/0/...) or in the Termux home are allowed.", null);
        }
        return p;
    }

    /** Equivalent spellings of the same shared-storage / Termux paths compare equal. */
    static String normPath(String p) {
        String s = p;
        while (s.length() > 1 && s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        String[][] map = {{"/sdcard", "/storage/emulated/0"}, {"/storage/self/primary", "/storage/emulated/0"},
                {"/mnt/sdcard", "/storage/emulated/0"}, {TERMUX_HOME + "/storage/shared", "/storage/emulated/0"}};
        for (String[] m : map) {
            if (s.equals(m[0]) || s.startsWith(m[0] + "/")) {
                return m[1] + s.substring(m[0].length());
            }
        }
        return s;
    }

    // ---------------------------------------------------------------- diagnostics
    void note(String line) {
        String clean = scrub(line);
        synchronized (diag) {
            diag.add(java.text.DateFormat.getTimeInstance().format(new java.util.Date()) + "  " + clean);
            while (diag.size() > 200) {
                diag.removeFirst();
            }
        }
    }

    List<String> diagnostics() {
        synchronized (diag) {
            return new ArrayList<String>(diag);
        }
    }

    private String scrub(String s) {
        if (s == null) {
            return "";
        }
        String out = s;
        try {
            String pw = host.serverPassword();
            if (pw != null && pw.length() >= 6) {
                out = out.replace(pw, "[redacted]");
            }
        } catch (Exception ignored) {
        }
        out = out.replaceAll("(?i)(authorization|bearer|api[_-]?key|token|password)([\"'=: ]+)[A-Za-z0-9._~+/=-]{8,}", "$1$2[redacted]");
        return out.length() > 2000 ? out.substring(0, 2000) + "..." : out;
    }

    private Status set(State st, String code, String msg, String detail, boolean managed, String ws, String version, Boolean auth, boolean wsVerified) {
        Status s = new Status(st, code, msg, detail == null ? null : scrub(detail), managed, ws, port(), version, auth, wsVerified);
        status = s;
        if (st == State.CONNECTION_FAILED || st == State.NOT_CONFIGURED || st == State.AUTHENTICATION_FAILED) {
            lastFailureStatus = s;
        }
        note(st.name() + (code == null ? "" : " [" + code + "]") + ": " + msg);
        try {
            host.publish(s);
        } catch (RuntimeException ignored) {
        }
        return s;
    }

    private Status fail(State st, String code, String msg, String detail) {
        lastFailureAt = System.currentTimeMillis();
        String ws = null;
        try {
            ws = workspace();
        } catch (Exception ignored) {
        }
        return set(st, code, msg, detail, isManaged(), ws, null, null, false);
    }

    private boolean isManaged() {
        return "1".equals(host.pref(K_MANAGED, "0")) && String.valueOf(port()).equals(host.pref(K_MANAGED_PORT, ""));
    }

    boolean managedByApp() { return isManaged(); }

    /** Installs a conservative Plan agent if absent and restarts only the server this app owns. */
    Status ensurePlanAgent() throws NativeBridge.BridgeException {
        synchronized (opLock) {
            String script = "set -eu\nagentdir=\"$HOME/.config/opencode/agents\"; planfile=\"$agentdir/plan.md\"; mkdir -p \"$agentdir\"\n"
                    + "if [ ! -e \"$planfile\" ]; then tmp=\"$planfile.tmp.$$\"; cat > \"$tmp\" <<'OCSI_PLAN_AGENT'\n"
                    + "---\n"
                    + "description: Read-only planning agent for OpenCode SI\n"
                    + "mode: primary\n"
                    + "permission:\n"
                    + "  edit: deny\n"
                    + "  bash: ask\n"
                    + "  external_directory: deny\n"
                    + "---\n"
                    + "You are the Plan agent in OpenCode SI. Analyze the request and current project. Produce a clear ordered plan, note risks and tests, and ask questions when needed. Do not modify project files or claim changes were made. Shell commands require explicit approval.\n"
                    + "OCSI_PLAN_AGENT\n"
                    + "mv -- \"$tmp\" \"$planfile\"; fi\nprintf 'PLAN_AGENT_FILE=%s\\n' \"$planfile\"";
            ScriptResult r = host.runScript(script, new String[0], 15000);
            if (r == null || !r.delivered || r.exitCode != 0) {
                throw new NativeBridge.BridgeException("PLAN_SETUP_FAILED", "Could not configure the Plan agent in Termux.", r == null ? null : (r.stderr + " " + r.error));
            }
            if (!isManaged()) {
                throw new NativeBridge.BridgeException("PLAN_RESTART_REQUIRED", "A Plan agent configuration was installed, but the connected OpenCode server was started outside OpenCode SI. Restart that server in Termux, then retry Plan.", r.stdout);
            }
            if (activeTasks.get() > 0) {
                throw new NativeBridge.BridgeException("PLAN_RESTART_BUSY", "The OpenCode server cannot be restarted while a task is running. Wait for the task to finish, then retry Plan.", null);
            }
            Status stopped = stopManagedLocked();
            if (stopped.state == State.CONNECTION_FAILED) return stopped;
            Status restarted = doEnsure(true, true);
            if (!restarted.ready()) {
                throw new NativeBridge.BridgeException(restarted.code == null ? "PLAN_RESTART_FAILED" : restarted.code,
                        "The Plan agent was configured, but OpenCode could not restart successfully: " + restarted.message, restarted.detail);
            }
            return restarted;
        }
    }

    // ---------------------------------------------------------------- ensureReady
    /**
     * Checks the server and, when {@code autostart} is set and it is down, starts it through Termux. Blocking; call from a
     * worker thread. Concurrent callers join the same in-flight run. {@code force} (explicit user retry) skips the cool-down.
     */
    Status ensureReady(final boolean autostart, final boolean force) {
        return singleFlight(new Callable<Status>() {
            public Status call() {
                synchronized (opLock) {
                    return doEnsure(autostart, force);
                }
            }
        });
    }

    private Status singleFlight(Callable<Status> job) {
        FutureTask<Status> task;
        boolean mine = false;
        synchronized (lock) {
            if (inflight == null) {
                inflight = new FutureTask<Status>(job);
                mine = true;
            }
            task = inflight;
        }
        if (mine) {
            try {
                task.run();
            } finally {
                synchronized (lock) {
                    inflight = null;
                }
            }
        }
        try {
            return task.get(cfg.startupTimeoutMs + cfg.launchTimeoutMs + 60000, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return status;
        } catch (ExecutionException e) {
            return fail(State.CONNECTION_FAILED, "INTERNAL", "Unexpected error while starting OpenCode.", e.getCause() == null ? null : e.getCause().getClass().getSimpleName());
        } catch (TimeoutException e) {
            return status;
        }
    }

    private Status doEnsure(boolean autostart, boolean force) {
        set(State.CHECKING_TERMUX, null, "Checking Termux...", null, isManaged(), null, null, null, false);
        boolean termux = host.termuxInstalled();
        if (!termux) {
            note("Termux is not installed (only matters if the server has to be started).");
        }
        String want;
        try {
            want = workspace();
        } catch (NativeBridge.BridgeException e) {
            return set(State.NOT_CONFIGURED, e.code, e.getMessage(), e.details, false, null, null, null, false);
        }
        OpenCodeClient cl;
        try {
            cl = client();
        } catch (NativeBridge.BridgeException e) {
            return set(State.NOT_CONFIGURED, e.code, e.getMessage(), e.details, false, want, null, null, false);
        }

        set(State.CHECKING_SERVER, null, "Looking for the OpenCode server on 127.0.0.1:" + port() + "...", null, isManaged(), want, null, null, false);
        OpenCodeClient.Health h = cl.health();
        note("health probe: " + h.kind + (h.detail == null ? "" : " (" + h.detail + ")"));

        if (h.kind == OpenCodeClient.Health.Kind.OK) {
            return attach(cl, h, want, autostart);
        }
        if (h.kind == OpenCodeClient.Health.Kind.AUTH) {
            return set(State.AUTHENTICATION_FAILED, "AUTH_REQUIRED", "A server is running on port " + port() + " but it needs a password this app does not know.", h.detail, isManaged(), want, null, null, false);
        }
        if (h.kind == OpenCodeClient.Health.Kind.NOT_OPENCODE || h.kind == OpenCodeClient.Health.Kind.ERROR) {
            return fail(State.CONNECTION_FAILED, "PORT_CONFLICT", "Port " + port() + " is in use by something that is not the OpenCode server. Nothing was stopped.", h.detail);
        }

        // DOWN: nothing is listening.
        if (!autostart) {
            return set(State.SERVER_STOPPED, "SERVER_DOWN", "The OpenCode server is not running.", null, isManaged(), want, null, null, false);
        }
        if (!force && autoDisabledByFailure && System.currentTimeMillis() - lastFailureAt < cfg.cooldownMs) {
            note("start skipped: cool-down after the last failed attempt");
            Status prev = lastFailureStatus;
            if (prev != null) {
                status = prev;                       // keep reporting the real failure, not a transient "checking" state
                return prev;
            }
            return status;
        }
        if (!termux) {
            return set(State.NOT_CONFIGURED, "TERMUX_MISSING", "Termux is not installed. Install Termux (F-Droid or GitHub build) to run OpenCode.", null, false, want, null, null, false);
        }
        if (!host.runCommandPermission()) {
            return set(State.NOT_CONFIGURED, "PERMISSION_MISSING", "OpenCode SI is not allowed to run commands in Termux (permission com.termux.permission.RUN_COMMAND).", null, false, want, null, null, false);
        }
        return launchAndWait(cl, want, everReady ? State.RESTARTING : State.STARTING_SERVER);
    }

    /** Healthy server found: reuse it only if it is safe (right folder). Never starts a second one. */
    private Status attach(OpenCodeClient cl, OpenCodeClient.Health h, String want, boolean autostart) {
        boolean managed = isManaged();
        Boolean anon = cl.acceptsAnonymous();
        String observedDir = null;
        try {
            observedDir = cl.directory();
        } catch (NativeBridge.BridgeException e) {
            if ("OPENCODE_AUTH_FAILED".equals(e.code)) {
                return set(State.AUTHENTICATION_FAILED, "AUTH_REJECTED", "The server rejected this app's credentials. It may have been started with a different password.", null, managed, want, h.version, null, false);
            }
            note("directory probe failed: " + e.code);
        }
        // The app may have been recreated or upgraded while its own Termux server kept running.
        // Recover ownership ONLY when the persisted launcher PID, live process command, port and cwd all agree.
        // This permits a safe workspace switch without ever killing an unrelated OpenCode process.
        if (!managed && observedDir != null && !normPath(observedDir).equals(normPath(want))
                && recoverManagedOwnership(observedDir)) {
            managed = true;
            host.setPref(K_MANAGED, "1");
            host.setPref(K_MANAGED_PORT, String.valueOf(port()));
            host.setPref(K_MANAGED_WS, observedDir);
            host.setPref(K_MANAGED_AT, String.valueOf(System.currentTimeMillis()));
            note("recovered app ownership from verified PID file for workspace " + observedDir);
        }
        if (managed) {
            String had = host.pref(K_MANAGED_WS, "");
            if (!normPath(had).equals(normPath(want))) {
                if (activeTasks.get() > 0) {
                    return set(State.CONNECTION_FAILED, "WORKSPACE_BUSY", "A task is still running in " + had + ". Wait for it to finish, or stop it, before switching folders.", null, true, want, h.version, anon == null ? null : Boolean.valueOf(!anon.booleanValue()), false);
                }
                if (!autostart) {
                    return set(State.CONNECTION_FAILED, "WORKSPACE_MISMATCH", "The running server works in " + had + " but the selected folder is " + want + ".", null, true, want, h.version, null, false);
                }
                note("workspace changed (" + had + " -> " + want + "): restarting the server that this app started");
                Status st = stopManagedLocked();
                if (st.state == State.CONNECTION_FAILED) {
                    return st;
                }
                return launchAndWait(cl, want, State.RESTARTING);
            }
        }
        boolean verified = managed;
        if (observedDir != null) {
            boolean same = normPath(observedDir).equals(normPath(want));
            if (!same && !managed) {
                return fail(State.CONNECTION_FAILED, "WORKSPACE_MISMATCH", "An OpenCode server is already running for another folder (" + observedDir + "), not " + want + ". SI could not verify ownership of that process, so it left it untouched.", null);
            }
            if (!same) {
                note("server reports directory " + observedDir + " (launched for " + want + "); the launcher may resolve symlinks");
            }
            verified = same || managed;
        } else {
            note("server does not report its directory (GET /path unavailable): folder not verifiable");
        }
        everReady = true;
        autoDisabledByFailure = false;
        refreshSpec(cl, h.version);
        String detail = managed ? null : "Attached to a server this app did not start; it will not be stopped by this app.";
        if (anon != null && anon.booleanValue()) {
            detail = (detail == null ? "" : detail + " ") + "Security: the server answers requests without a password, so other apps on this phone can reach it.";
        }
        return set(State.READY, null, "OpenCode " + (h.version == null || h.version.length() == 0 ? "" : h.version + " ") + "is ready.", detail, managed, want, h.version, anon == null ? null : Boolean.valueOf(!anon.booleanValue()), verified);
    }

    private boolean recoverManagedOwnership(String serverDir) {
        try {
            ScriptResult r = host.runScript(OWNERSHIP_SCRIPT, new String[]{String.valueOf(port()), serverDir}, 8000);
            String out = (r.stdout == null ? "" : r.stdout).trim();
            note("ownership verification: delivered=" + r.delivered + " exit=" + r.exitCode + " out=" + clip(out));
            if (!r.delivered || r.exitCode != 0 || !out.contains("OWNED_PID=")) return false;
            String cwd = null;
            for (String line : out.split("\\r?\\n")) {
                if (line.startsWith("OWNED_CWD=")) cwd = line.substring("OWNED_CWD=".length()).trim();
            }
            return cwd != null && normPath(cwd).equals(normPath(serverDir));
        } catch (Exception e) {
            note("ownership verification unavailable: " + e.getClass().getSimpleName());
            return false;
        }
    }

    private Status launchAndWait(OpenCodeClient cl, String want, State phase) {
        set(phase, null, phase == State.RESTARTING ? "Restarting OpenCode..." : "Starting OpenCode...", null, false, want, null, null, false);
        launches.incrementAndGet();
        ScriptResult r;
        try {
            r = host.runScript(START_SCRIPT, new String[]{want, String.valueOf(port()), host.serverPassword()}, cfg.launchTimeoutMs);
        } catch (NativeBridge.BridgeException e) {
            autoDisabledByFailure = true;
            State st = "PERMISSION_DENIED".equals(e.code) ? State.NOT_CONFIGURED : State.CONNECTION_FAILED;
            lastFailureAt = System.currentTimeMillis();
            return set(st, e.code, e.getMessage(), e.details, false, want, null, null, false);
        }
        note("termux start script: delivered=" + r.delivered + " exit=" + r.exitCode + " stdout=" + clip(r.stdout) + " stderr=" + clip(r.stderr) + (r.error == null ? "" : " err=" + r.error));
        if (r.delivered && r.exitCode != 0) {
            autoDisabledByFailure = true;
            lastFailureAt = System.currentTimeMillis();
            if (r.exitCode == 127) {
                return set(State.NOT_CONFIGURED, "OPENCODE_NOT_FOUND", "The OpenCode executable was not found in Termux. Install OpenCode in Termux and run the setup check.", r.stderr, false, want, null, null, false);
            }
            if (r.exitCode == 20 || r.exitCode == 21) {
                return set(State.NOT_CONFIGURED, "WORKSPACE_INACCESSIBLE", "Termux cannot use the folder " + want + ". Run termux-setup-storage in Termux and make sure the folder exists.", r.stderr, false, want, null, null, false);
            }
            return set(State.CONNECTION_FAILED, "START_FAILED", "Termux could not start the OpenCode server (exit " + r.exitCode + ").", r.stderr.length() > 0 ? r.stderr : r.stdout, false, want, null, null, false);
        }
        set(State.WAITING_FOR_HEALTH, null, "Waiting for OpenCode to answer...", r.delivered ? null : "Termux did not report a result for the start command; waiting for the server itself.", false, want, null, null, false);
        long deadline = System.currentTimeMillis() + cfg.startupTimeoutMs;
        long wait = cfg.pollMinMs;
        OpenCodeClient.Health h = null;
        int probes = 0;
        while (System.currentTimeMillis() < deadline) {
            h = cl.health();
            probes++;
            if (h.kind == OpenCodeClient.Health.Kind.OK) {
                host.setPref(K_MANAGED, "1");
                host.setPref(K_MANAGED_PORT, String.valueOf(port()));
                host.setPref(K_MANAGED_WS, want);
                host.setPref(K_MANAGED_AT, String.valueOf(System.currentTimeMillis()));
                note("healthy after " + probes + " probe(s)");
                return attach(cl, h, want, false);
            }
            if (h.kind == OpenCodeClient.Health.Kind.AUTH) {
                return set(State.AUTHENTICATION_FAILED, "AUTH_REJECTED", "The server started but rejected this app's credentials.", h.detail, false, want, null, null, false);
            }
            if (h.kind == OpenCodeClient.Health.Kind.NOT_OPENCODE) {
                autoDisabledByFailure = true;
                return fail(State.CONNECTION_FAILED, "PORT_CONFLICT", "Port " + port() + " answered, but not as an OpenCode server.", h.detail);
            }
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return status;
            }
            wait = Math.min(cfg.pollMaxMs, wait + wait / 2 + 100);
        }
        autoDisabledByFailure = true;
        String log = tailLog();
        return fail(State.CONNECTION_FAILED, "STARTUP_TIMEOUT", "The OpenCode server did not become healthy within " + (cfg.startupTimeoutMs / 1000) + " s.", log);
    }

    private String tailLog() {
        try {
            ScriptResult r = host.runScript(LOG_SCRIPT, new String[0], 8000);
            String t = (r.stdout.length() > 0 ? r.stdout : r.stderr).trim();
            note("server log tail:\n" + t);
            return t.length() == 0 ? null : t;
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- recheck / stop
    /** Cheap health re-check (app resumed, connection error). Does not start anything. */
    Status recheck() {
        synchronized (lock) {
            if (inflight != null) {
                return status;                       // a start/stop is running: its result is the truth
            }
        }
        OpenCodeClient cl;
        try {
            cl = client();
        } catch (NativeBridge.BridgeException e) {
            return status;
        }
        OpenCodeClient.Health h = cl.health();
        Status cur = status;
        if (h.kind == OpenCodeClient.Health.Kind.OK) {
            if (cur.state != State.READY) {
                return ensureReady(false, false);
            }
            return cur;
        }
        if (cur.state == State.READY) {
            return set(h.kind == OpenCodeClient.Health.Kind.AUTH ? State.AUTHENTICATION_FAILED : State.SERVER_STOPPED,
                    h.kind == OpenCodeClient.Health.Kind.AUTH ? "AUTH_REJECTED" : "SERVER_DOWN",
                    h.kind == OpenCodeClient.Health.Kind.AUTH ? "The server no longer accepts this app's credentials." : "The OpenCode server stopped answering.",
                    h.detail, cur.managed, cur.workspace, cur.version, cur.authEnforced, false);
        }
        return cur;
    }

    /** Stops the server this app started. Refuses foreign servers; refuses while a task runs unless {@code force}. */
    Status stopManaged(final boolean force) throws NativeBridge.BridgeException {
        if (!isManaged()) {
            throw new NativeBridge.BridgeException("NOT_MANAGED", "This server was not started by OpenCode SI, so it will not be stopped from here. Stop it in Termux if you want it gone.", null);
        }
        if (activeTasks.get() > 0 && !force) {
            throw new NativeBridge.BridgeException("TASK_RUNNING", "An agent task is still running. Stop the task first or confirm to stop the server anyway.", null);
        }
        synchronized (opLock) {
            return stopManagedLocked();
        }
    }

    private Status stopManagedLocked() {
        String ws = null;
        try {
            ws = workspace();
        } catch (Exception ignored) {
        }
        set(State.STOPPING, null, "Stopping the OpenCode server started by this app...", null, true, ws, null, null, false);
        ScriptResult r;
        try {
            r = host.runScript(STOP_SCRIPT, new String[]{String.valueOf(port())}, 20000);
        } catch (NativeBridge.BridgeException e) {
            return set(State.CONNECTION_FAILED, e.code, e.getMessage(), e.details, true, ws, null, null, false);
        }
        String out = r.stdout.trim();
        note("stop script: delivered=" + r.delivered + " exit=" + r.exitCode + " out=" + clip(out));
        if (r.delivered && r.exitCode == 4) {
            host.setPref(K_MANAGED, "0");
            return set(State.CONNECTION_FAILED, "NOT_OURS", "The recorded process is no longer the OpenCode server this app started. Nothing was stopped.", out, false, ws, null, null, false);
        }
        if (!r.delivered) {
            return set(State.CONNECTION_FAILED, "STOP_UNCONFIRMED", "Termux did not confirm the stop command.", null, true, ws, null, null, false);
        }
        long end = System.currentTimeMillis() + 8000;
        OpenCodeClient.Health h = null;
        try {
            OpenCodeClient cl = client();
            while (System.currentTimeMillis() < end) {
                h = cl.health();
                if (h.kind == OpenCodeClient.Health.Kind.DOWN) {
                    break;
                }
                Thread.sleep(300);
            }
        } catch (NativeBridge.BridgeException e) {
            h = null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (h != null && h.kind != OpenCodeClient.Health.Kind.DOWN) {
            return set(State.CONNECTION_FAILED, "STOP_FAILED", "The server is still answering after the stop command.", out, true, ws, null, null, false);
        }
        host.setPref(K_MANAGED, "0");
        everReady = false;
        autoDisabledByFailure = false;
        return set(State.SERVER_STOPPED, null, "The OpenCode server was stopped.", null, false, ws, null, null, false);
    }

    private static String clip(String s) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        return t.length() > 300 ? t.substring(0, 300) + "..." : t;
    }

    // ---------------------------------------------------------------- API capability
    private void refreshSpec(OpenCodeClient cl, String version) {
        String v = version == null ? "" : version;
        if (specCache != null && v.equals(specVersion)) {
            return;
        }
        java.util.Set<String> s = cl.spec();
        specCache = s;
        specVersion = v;
        note(s == null ? "OpenAPI document not available: optional routes will be tried and errors reported" : "OpenAPI document read: " + s.size() + " operations");
    }

    /** true = listed, false = the server's spec does not list it, null = spec unavailable (unknown). Path params match as {}. */
    Boolean supports(String method, String path) {
        java.util.Set<String> s = specCache;
        if (s == null) {
            return null;
        }
        String want = method.toUpperCase(Locale.US) + " " + path.replaceAll("\\{[^}]*\\}", "{}");
        for (String have : s) {
            if (have.replaceAll("\\{[^}]*\\}", "{}").equals(want)) {
                return Boolean.TRUE;
            }
        }
        return Boolean.FALSE;
    }

    // ---------------------------------------------------------------- setup wizard
    /** Real probes only. Each entry: {key,name,status(ok|warning|failed|unknown),detail,raw}. */
    /**
     * Idempotent shared-storage setup. Do not rerun termux-setup-storage when its shared
     * link is already readable/writable: Termux then displays a rebuild confirmation and
     * a non-interactive RUN_COMMAND cannot answer it. If access is missing, request setup.
     * Final success is always determined by setupChecks(), not by this command's exit code.
     */
    JSONObject requestStorageSetup() throws NativeBridge.BridgeException {
        String script = "shared=\"$HOME/storage/shared\"; "
                + "if [ -d \"$shared\" ] && [ -r \"$shared\" ] && [ -w \"$shared\" ]; then "
                + "printf 'STORAGE_ACCESS_ALREADY_READY\n'; exit 0; fi; "
                + "termux-setup-storage; rc=$?; "
                + "if [ $rc -ne 0 ]; then echo STORAGE_SETUP_FAILED; exit $rc; fi; "
                + "if [ -d \"$shared\" ]; then echo STORAGE_LINKS_CREATED_CHECK_PERMISSION; exit 0; "
                + "else echo STORAGE_LINKS_NOT_CREATED; exit 12; fi";
        ScriptResult r = host.runScript(script, new String[0], 20000);
        try {
            return new JSONObject()
                    .put("delivered", r.delivered)
                    .put("exitCode", r.exitCode)
                    .put("stdout", r.stdout == null ? "" : r.stdout)
                    .put("stderr", r.stderr == null ? "" : r.stderr)
                    .put("error", r.error == null ? JSONObject.NULL : r.error);
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("STORAGE_SETUP_ERROR", "Could not read Termux storage setup result.", e.getMessage());
        }
    }

    JSONArray setupChecks() {
        JSONArray out = new JSONArray();
        boolean termux = host.termuxInstalled();
        add(out, "termux_app", "Termux installed", termux ? "ok" : "failed", termux ? "Termux is installed." : "Termux is not installed. Install it from F-Droid or GitHub.", null);
        boolean perm = host.runCommandPermission();
        add(out, "run_command_permission", "Permission to run Termux commands", perm ? "ok" : "failed", perm ? "RUN_COMMAND is granted." : "RUN_COMMAND is not granted to OpenCode SI.", perm ? null : "com.termux.permission.RUN_COMMAND");
        String ws = null;
        String wsErr = null;
        try {
            ws = workspace();
        } catch (NativeBridge.BridgeException e) {
            wsErr = e.getMessage();
        }
        add(out, "workspace_setting", "Workspace folder", ws != null ? "ok" : "failed", ws != null ? ws : wsErr, null);

        if (!termux || !perm) {
            add(out, "external_apps", "Termux accepts external commands", "unknown", "Cannot be tested until Termux is installed and the permission is granted.", null);
        } else {
            try {
                ScriptResult r = host.runScript(PROBE_SCRIPT, new String[]{ws == null ? "/nonexistent" : ws}, 20000);
                String runError = r.error == null ? "" : r.error;
                String runStderr = r.stderr == null ? "" : r.stderr;
                boolean blockedExternalApps = (runError + "\n" + runStderr).toLowerCase(Locale.US).contains("allow-external-apps")
                        || (runError + "\n" + runStderr).contains("RunCommandService requires");
                if (!r.delivered) {
                    add(out, "external_apps", "Termux accepts external commands", "warning", "Termux did not return a command result. Check allow-external-apps = true in ~/.termux/termux.properties, then fully restart Termux. This check is unknown until a test command succeeds.", r.error);
                } else if (blockedExternalApps || r.error != null || r.exitCode != 0) {
                    String detail = blockedExternalApps
                            ? "Termux blocked the external command. Set allow-external-apps = true in ~/.termux/termux.properties, then fully close and reopen Termux."
                            : "Termux returned a failed probe (exit " + r.exitCode + "). " + (runError.isEmpty() ? runStderr : runError);
                    add(out, "external_apps", "Termux accepts external commands", "failed", detail, (runError + "\n" + runStderr).trim());
                } else {
                    add(out, "external_apps", "Termux accepts external commands", "ok", "Termux ran a test command and returned success.", null);
                    String p = line(r.stdout, "OC_PATH="), exec = line(r.stdout, "OC_EXEC="), ver = line(r.stdout, "OC_VERSION="), w = line(r.stdout, "WS=");
                    boolean found = "1".equals(exec);
                    add(out, "opencode_found", "OpenCode executable", found ? "ok" : "failed", found ? p : "OpenCode was not found in Termux (looked for " + p + ").", null);
                    boolean runs = found && ver != null && ver.length() > 0 && !ver.toLowerCase(Locale.US).contains("not found") && !ver.toLowerCase(Locale.US).contains("error");
                    add(out, "opencode_runs", "OpenCode runs", found ? (runs ? "ok" : "failed") : "unknown", runs ? "opencode --version: " + ver : (found ? "opencode --version failed: " + ver : "Not tested."), null);
                    add(out, "opencode_version", "OpenCode version", versionStatus(ver, runs), versionDetail(ver, runs), null);
                    String ws2 = "ok".equals(w) ? "ok" : "failed";
                    add(out, "workspace_access", "Workspace folder accessible from Termux", ws2, "ok".equals(w) ? "Termux can read and write " + ws : ("missing".equals(w) ? "The selected folder does not exist in Termux. Choose an existing folder or create it, then re-check." : "Termux cannot read/write the selected folder. Run termux-setup-storage in Termux, approve Android storage permission if prompted, and re-check."), null);
                }
            } catch (NativeBridge.BridgeException e) {
                add(out, "external_apps", "Termux accepts external commands", "failed", e.getMessage(), e.details);
            }
        }

        OpenCodeClient cl = null;
        try {
            cl = client();
        } catch (NativeBridge.BridgeException e) {
            add(out, "server_running", "OpenCode server running", "failed", e.getMessage(), e.code);
        }
        if (cl != null) {
            OpenCodeClient.Health h = cl.health();
            boolean up = h.kind == OpenCodeClient.Health.Kind.OK;
            add(out, "server_running", "OpenCode server running", up ? "ok" : (h.kind == OpenCodeClient.Health.Kind.DOWN ? "warning" : "failed"),
                    up ? "Answering on 127.0.0.1:" + port() : (h.kind == OpenCodeClient.Health.Kind.DOWN ? "Not running yet (the app starts it automatically)." : "Port " + port() + ": " + h.kind + " " + (h.detail == null ? "" : h.detail)), null);
            add(out, "server_health", "Health endpoint", up ? "ok" : "unknown", up ? "GET /global/health returned HTTP 200 (version " + h.version + ")." : "Not tested: the server is not up.", null);
            if (up) {
                try {
                    String provDetail;
                    String provStatus;
                    try {
                        JSONObject p = cl.providers();
                        JSONArray list = p.optJSONArray("providers");
                        int n = list == null ? 0 : list.length();
                        provStatus = n > 0 ? "ok" : "warning";
                        provDetail = n > 0 ? n + " provider(s) configured in OpenCode. Whether your account is accepted is only proven by the first message." : "OpenCode reports no configured providers.";
                    } catch (NativeBridge.BridgeException e) {
                        provStatus = "unknown";
                        provDetail = "Could not read providers (" + e.code + "). Run `opencode auth list` in Termux.";
                    }
                    add(out, "provider_auth", "Provider authentication", provStatus, provDetail, null);
                    String id = cl.createSession();
                    String del = "";
                    try {
                        cl.deleteSession(id);
                        del = " and removed again";
                    } catch (NativeBridge.BridgeException e) {
                        del = " (it could not be removed: " + e.code + ")";
                    }
                    add(out, "test_session", "Test session", "ok", "POST /session created " + id + del + ".", null);
                } catch (NativeBridge.BridgeException e) {
                    add(out, "test_session", "Test session", "failed", e.getMessage(), e.code);
                }
            } else {
                add(out, "provider_auth", "Provider authentication", "unknown", "Not tested: the server is not up.", null);
                add(out, "test_session", "Test session", "unknown", "Not tested: the server is not up.", null);
            }
        }
        boolean allOk = true;
        for (int i = 0; i < out.length(); i++) {
            String s = out.optJSONObject(i).optString("status");
            if ("failed".equals(s)) {
                allOk = false;
            }
        }
        if (allOk) {
            host.setPref(K_SETUP_DONE, "1");
        }
        return out;
    }

    private static String versionStatus(String ver, boolean runs) {
        if (!runs) {
            return "unknown";
        }
        return ver.equals(TESTED_VERSION) ? "ok" : "warning";
    }

    private static String versionDetail(String ver, boolean runs) {
        if (!runs) {
            return "Not tested.";
        }
        return ver.equals(TESTED_VERSION) ? ver + " (the tested version)." : ver + ". This app was written against " + TESTED_VERSION + "; other versions may differ.";
    }

    private static String line(String text, String prefix) {
        for (String l : text.split("\n")) {
            if (l.startsWith(prefix)) {
                return l.substring(prefix.length()).trim();
            }
        }
        return null;
    }

    private static void add(JSONArray a, String key, String name, String status, String detail, String raw) {
        try {
            a.put(new JSONObject().put("key", key).put("name", name).put("status", status).put("detail", detail == null ? "" : detail).put("raw", raw == null ? JSONObject.NULL : raw));
        } catch (Exception ignored) {
        }
    }
}
