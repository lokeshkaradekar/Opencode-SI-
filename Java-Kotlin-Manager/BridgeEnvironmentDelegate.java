package com.opencode.mobile;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.StatFs;
import org.json.JSONArray;
import org.json.JSONObject;

/** Environment, daemon reachability, permissions and health diagnostics delegated by NativeBridge. */
final class BridgeEnvironmentDelegate {
    private static final String APP_VERSION = NativeBridge.APP_VERSION;
    private static final String WORKSPACE_DISPLAY = NativeBridge.WORKSPACE_DISPLAY;
    private final Activity activity;
    private final TermuxBackend termux;
    private final OpenCodeRuntime oc;

    BridgeEnvironmentDelegate(Activity activity, TermuxBackend termux, OpenCodeRuntime oc) {
        this.activity = activity;
        this.termux = termux;
        this.oc = oc;
    }

    private long freeMb() {
        StatFs fs = new StatFs(activity.getFilesDir().getPath());
        return fs.getAvailableBytes() / (1024 * 1024);
    }

    JSONObject environment() throws Exception {
        String arch = Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "unknown";
        JSONObject env = new JSONObject().put("backend", "local").put("bridge", APP_VERSION)
                .put("android", new JSONObject().put("version", Build.VERSION.RELEASE).put("api", Build.VERSION.SDK_INT))
                .put("arch", arch).put("termux", termux.termuxVersion() == null ? JSONObject.NULL : termux.termuxVersion())
                .put("shell", "bash").put("workspace", WORKSPACE_DISPLAY).put("storageFreeMB", freeMb());
        try {
            JSONObject ping = termux.ping();
            env.put("daemon", ping.optString("daemon")).put("pty", true).put("workspaceAbsolute", ping.optString("workspace"));
        } catch (NativeBridge.BridgeException e) {
            env.put("daemon", JSONObject.NULL).put("pty", false).put("daemonError", e.code);
        }
        return env;
    }

    JSONObject daemonStatus() throws Exception {
        JSONObject s = new JSONObject().put("port", termux.port()).put("termuxInstalled", termux.termuxInstalled())
                .put("runCommandPermission", termux.hasRunCommandPermission());
        try {
            JSONObject ping = termux.ping();
            s.put("reachable", true).put("authenticated", true).put("version", ping.optString("daemon")).put("workspace", ping.optString("workspace"));
        } catch (NativeBridge.BridgeException e) {
            s.put("reachable", !"DAEMON_UNREACHABLE".equals(e.code) && !"DAEMON_TIMEOUT".equals(e.code))
                    .put("authenticated", false).put("error", e.code).put("message", e.getMessage());
        }
        return s;
    }

    void requestPermission() throws NativeBridge.BridgeException {
        if (!termux.termuxInstalled()) {
            throw new NativeBridge.BridgeException("BACKEND_UNAVAILABLE", "Termux is not installed.", null);
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
    JSONObject healthCheck() throws Exception {
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
        } catch (NativeBridge.BridgeException e) {
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
            } catch (NativeBridge.BridgeException e) {
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

}
