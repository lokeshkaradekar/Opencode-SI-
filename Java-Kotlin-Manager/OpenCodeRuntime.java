package com.opencode.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * Process-wide holder for the OpenCode server manager and agent.
 *
 * It is deliberately NOT owned by the Activity or by NativeBridge: Android recreates the Activity (and the bridge) on
 * WebView crashes and configuration changes, and a task may outlive the screen. One static instance per process means
 * there is exactly one lifecycle manager, so recreating the Activity can never start a second server, and a running
 * task keeps its registry. It holds only the application Context (no Activity leak); the event sink is detached when
 * the Activity goes away.
 */
final class OpenCodeRuntime {
    static final String SECRET_ID = "opencode.server";
    private static final Pattern PASSWORD_RE = Pattern.compile("^[A-Za-z0-9._~-]{8,128}$");
    private static OpenCodeRuntime instance;

    final OpenCodeServer server;
    final OpenCodeAgent agent;
    final AndroidHost host;
    private volatile OpenCodeAgent.Events sink;

    private OpenCodeRuntime(Context app) {
        this.host = new AndroidHost(app);
        this.server = new OpenCodeServer(host, new OpenCodeServer.ClientFactory() {
            public OpenCodeClient create(int port, String password) {
                return new OpenCodeClient(port, password);
            }
        }, new OpenCodeServer.Settings());
        this.agent = new OpenCodeAgent(server, host);
        final OpenCodeRuntime self = this;
        this.agent.setEvents(new OpenCodeAgent.Events() {
            public void emit(String name, JSONObject payload) {
                if ("opencode.task".equals(name)) {
                    String state = payload == null ? "" : payload.optString("state", "");
                    String project = host.backendPrefs.getString("active_project", "Open project");
                    if ("RUNNING".equals(state)) {
                        TaskNotificationService.update(app, project, "AI task is running", "AI task running");
                    } else if (state.length() > 0) {
                        String label = "SUCCESS".equals(state) ? "AI task completed" : "CANCELLED".equals(state) ? "AI task cancelled" : "AI task failed";
                        TaskNotificationService.finish(app, project, label, "Task " + state);
                    }
                }
                OpenCodeAgent.Events s = self.sink;
                if (s != null) s.emit(name, payload);
            }
        });
    }

    static synchronized OpenCodeRuntime get(Context context) {
        if (instance == null) {
            instance = new OpenCodeRuntime(context.getApplicationContext());
        }
        return instance;
    }

    void attach(OpenCodeAgent.Events s) {
        this.sink = s;
    }

    void detach(OpenCodeAgent.Events s) {
        if (this.sink == s) {
            this.sink = null;
        }
    }

    /** Stores a password for a server this app did not start (write-only from JS). */
    void setServerPassword(String pw) throws NativeBridge.BridgeException {
        if (pw == null || !PASSWORD_RE.matcher(pw).matches()) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "The password must be 8-128 characters: letters, digits and . _ ~ - only.", null);
        }
        try {
            host.secrets.put(SECRET_ID, pw);
        } catch (SecureStore.SecureStoreException e) {
            throw new NativeBridge.BridgeException(e.code, e.getMessage(), null);
        }
    }

    /** Android implementation of the lifecycle manager's host interface. */
    static final class AndroidHost implements OpenCodeServer.Host {
        final SecureStore secrets;
        private final TermuxBackend termux;
        private final SharedPreferences prefs;
        private final SharedPreferences backendPrefs;
        AndroidHost(Context app) {
            this.secrets = new SecureStore(app);
            this.termux = new TermuxBackend(app, secrets);
            this.prefs = app.getSharedPreferences("opencode_si_oc", Context.MODE_PRIVATE);
            this.backendPrefs = app.getSharedPreferences("opencode_si_backend", Context.MODE_PRIVATE);
        }

        public boolean termuxInstalled() {
            return termux.termuxInstalled();
        }

        public boolean runCommandPermission() {
            return termux.hasRunCommandPermission();
        }

        public OpenCodeServer.ScriptResult runScript(String script, String[] args, long timeoutMs) throws NativeBridge.BridgeException {
            return termux.runScript(script, args, timeoutMs);
        }

        public String pref(String key, String def) {
            return prefs.getString(key, def);
        }

        public void setPref(String key, String value) {
            prefs.edit().putString(key, value).commit();
        }

        public String serverPassword() throws NativeBridge.BridgeException {
            try {
                return secrets.getOrCreateRandom(SECRET_ID);
            } catch (SecureStore.SecureStoreException e) {
                throw new NativeBridge.BridgeException(e.code, e.getMessage(), null);
            }
        }

        public String activeProjectDir() {
            String p = backendPrefs.getString("active_project", null);
            if (p == null || !p.matches("^[A-Za-z0-9._ -]{1,64}$")) {
                return null;
            }
            String saved = backendPrefs.getString("active_project_path", null);
            if (saved != null && saved.startsWith("/") && !saved.contains("\0")) return saved;
            return TermuxBackend.TERMUX_HOME + "/" + TermuxBackend.WORKSPACE_REL + "/" + p;
        }

        public void publish(OpenCodeServer.Status s) {
            OpenCodeAgent.Events e = OpenCodeRuntime.instance == null ? null : OpenCodeRuntime.instance.sink;
            if (e != null) {
                e.emit("opencode.state", s.toJson(OpenCodeRuntime.instance.server.activeTasks()));
            }
        }
    }
}
