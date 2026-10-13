package com.opencode.mobile;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Plain-Java tests (no JUnit, no Android): java com.opencode.mobile.OpenCodeServerTest
 *
 * What is REAL here: the lifecycle manager, the HTTP client, the agent layer, the real bash Termux scripts (START / STOP /
 * PROBE) running against a fake `opencode` executable, real processes, real sockets.
 * What is FAKE: the OpenCode server's brain (a scripted HTTP server speaking the routes this app uses) and the Android
 * RUN_COMMAND hop (replaced by running bash directly). So these tests prove OpenCode SI's logic, not that OpenCode 1.18.33
 * answers exactly as scripted, and not that Termux's RUN_COMMAND accepts the intent. See docs/STATUS.md.
 */
public class OpenCodeServerTest {
    static final Charset UTF8 = Charset.forName("UTF-8");
    static int runs = 0, fails = 0;
    static String current = "";

    static void check(boolean ok, String what) {
        runs++;
        if (!ok) {
            fails++;
            System.out.println("  FAIL [" + current + "] " + what);
        }
    }

    interface Case {
        void run() throws Exception;
    }

    static void test(String name, Case c) {
        current = name;
        try {
            c.run();
            System.out.println("ok   " + name);
        } catch (Throwable t) {
            fails++;
            runs++;
            System.out.println("FAIL " + name + " threw " + t);
            t.printStackTrace(System.out);
        }
    }

    static int freePort() throws IOException {
        ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        try {
            return s.getLocalPort();
        } finally {
            s.close();
        }
    }

    // ===================================================================== scripted OpenCode HTTP server
    static final class Fake {
        HttpServer srv;
        int port;
        volatile String directory = OpenCodeServer.DEFAULT_WORKSPACE;
        volatile String password;                         // non-null: require Basic auth on every route
        volatile boolean doc = true, abortRoute = true, providersRoute = true, pathRoute = true;
        volatile String agentsJson = null;                // null = GET /agent 404 (route unknown); else the literal array
        volatile long messageDelayMs = 0;
        volatile String behavior = "normal";              // normal | drop-before | drop-after | drop-after-unfinished | provider-error | http500 | model-error
        final AtomicInteger drops = new AtomicInteger();   // how many times the connection is dropped before behaving normally
        final AtomicInteger sessionSeq = new AtomicInteger();
        final AtomicInteger userMessagesSeen = new AtomicInteger();
        final AtomicInteger aborts = new AtomicInteger();
        final Map<String, List<JSONObject>> msgs = new HashMap<String, List<JSONObject>>();
        final List<String> bodies = Collections.synchronizedList(new ArrayList<String>());

        void start(int p) throws IOException {
            port = p;
            srv = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 0);
            srv.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
            srv.createContext("/", new HttpHandler() {
                public void handle(HttpExchange ex) throws IOException {
                    try {
                        route(ex);
                    } catch (Exception e) {
                        send(ex, 500, "{\"message\":\"fake server bug: " + e + "\"}");
                    }
                }
            });
            srv.start();
        }

        void stop() {
            if (srv != null) {
                srv.stop(0);
                srv = null;
            }
        }

        boolean up() {
            return srv != null;
        }

        void send(HttpExchange ex, int code, String body) throws IOException {
            byte[] b = body.getBytes(UTF8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(code, b.length == 0 ? -1 : b.length);
            if (b.length > 0) {
                OutputStream os = ex.getResponseBody();
                os.write(b);
                os.close();
            }
            ex.close();
        }

        static String read(InputStream in) throws IOException {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), UTF8);
        }

        JSONObject userMsg(String sid, String text) throws Exception {
            return new JSONObject().put("info", new JSONObject().put("id", "msg_u" + userMessagesSeen.get()).put("role", "user").put("sessionID", sid))
                    .put("parts", new JSONArray().put(new JSONObject().put("type", "text").put("text", text)));
        }

        JSONObject assistantMsg(String sid, boolean completed, JSONObject error) throws Exception {
            JSONObject time = new JSONObject().put("created", 1);
            if (completed) {
                time.put("completed", 2);
            }
            JSONObject info = new JSONObject().put("id", "msg_a" + userMessagesSeen.get()).put("role", "assistant").put("sessionID", sid).put("time", time);
            if (error != null) {
                info.put("error", error);
            }
            JSONArray parts = new JSONArray()
                    .put(new JSONObject().put("type", "tool").put("tool", "write").put("state", new JSONObject().put("status", "completed").put("input", new JSONObject().put("filePath", "src/a.txt"))))
                    .put(new JSONObject().put("type", "tool").put("tool", "bash").put("state", new JSONObject().put("status", "error").put("error", "exit 1").put("input", new JSONObject().put("command", "npm test"))))
                    .put(new JSONObject().put("type", "text").put("text", error == null ? "Done." : ""));
            return new JSONObject().put("info", info).put("parts", parts);
        }

        void route(HttpExchange ex) throws Exception {
            String path = ex.getRequestURI().getPath(), method = ex.getRequestMethod();
            String body = read(ex.getRequestBody());
            if (password != null) {
                String want = "Basic " + OpenCodeClient.base64(("opencode:" + password).getBytes(UTF8));
                if (!want.equals(ex.getRequestHeaders().getFirst("Authorization"))) {
                    send(ex, 401, "{\"error\":\"unauthorized\"}");
                    return;
                }
            }
            if (path.equals("/global/health")) {
                send(ex, 200, "{\"healthy\":true,\"version\":\"1.18.33-termux\"}");
            } else if (path.equals("/path")) {
                if (!pathRoute) {
                    send(ex, 404, "{}");
                } else {
                    send(ex, 200, new JSONObject().put("directory", directory).toString());
                }
            } else if (path.equals("/doc")) {
                if (!doc) {
                    send(ex, 404, "{}");
                    return;
                }
                JSONObject paths = new JSONObject()
                        .put("/session", new JSONObject().put("get", new JSONObject()).put("post", new JSONObject()))
                        .put("/session/{sessionID}/message", new JSONObject().put("get", new JSONObject()).put("post", new JSONObject()));
                if (abortRoute) {
                    paths.put("/session/{sessionID}/abort", new JSONObject().put("post", new JSONObject()));
                }
                send(ex, 200, new JSONObject().put("paths", paths).toString());
            } else if (path.equals("/session") && method.equals("POST")) {
                String id = "ses_" + sessionSeq.incrementAndGet();
                synchronized (msgs) {
                    msgs.put(id, new ArrayList<JSONObject>());
                }
                send(ex, 200, new JSONObject().put("id", id).put("title", "").toString());
            } else if (path.equals("/session") && method.equals("GET")) {
                send(ex, 200, "[]");
            } else if (path.equals("/config/providers")) {
                if (!providersRoute) {
                    send(ex, 404, "{}");
                    return;
                }
                JSONObject models = new JSONObject().put("big-pickle", new JSONObject().put("id", "big-pickle").put("name", "Big Pickle"))
                        .put("exo-free", new JSONObject().put("id", "exo-free").put("name", "Exo"));
                send(ex, 200, new JSONObject().put("providers", new JSONArray().put(new JSONObject().put("id", "opencode").put("name", "OpenCode Zen").put("models", models))).toString());
            } else if (path.equals("/agent") && method.equals("GET")) {
                if (agentsJson == null) {
                    send(ex, 404, "{}");
                } else {
                    send(ex, 200, agentsJson);
                }
            } else if (path.matches("/session/[^/]+/message") && method.equals("GET")) {
                String sid = path.split("/")[2];
                JSONArray a = new JSONArray();
                synchronized (msgs) {
                    List<JSONObject> l = msgs.get(sid);
                    if (l == null) {
                        send(ex, 404, "{\"message\":\"session not found\"}");
                        return;
                    }
                    for (JSONObject m : l) {
                        a.put(m);
                    }
                }
                send(ex, 200, a.toString());
            } else if (path.matches("/session/[^/]+/message") && method.equals("POST")) {
                postMessage(ex, path.split("/")[2], body);
            } else if (path.matches("/session/[^/]+/abort") && method.equals("POST")) {
                if (!abortRoute) {
                    send(ex, 404, "{}");
                } else {
                    aborts.incrementAndGet();
                    send(ex, 200, "true");
                }
            } else {
                send(ex, 404, "{\"message\":\"no such route\"}");
            }
        }

        void postMessage(HttpExchange ex, String sid, String body) throws Exception {
            bodies.add(body);
            String text = new JSONObject(body).optJSONArray("parts").optJSONObject(0).optString("text");
            String b = behavior;
            if (drops.get() > 0 && drops.getAndDecrement() > 0) {
                if (b.equals("drop-before")) {
                    ex.close();
                    return;
                }
                userMessagesSeen.incrementAndGet();
                synchronized (msgs) {
                    msgs.get(sid).add(userMsg(sid, text));
                    if (b.equals("drop-after")) {
                        msgs.get(sid).add(assistantMsg(sid, true, null));
                    } else {
                        msgs.get(sid).add(assistantMsg(sid, false, null));      // started, never finished
                    }
                }
                ex.close();
                return;
            }
            if (b.equals("http500")) {
                send(ex, 500, "{\"message\":\"upstream exploded\"}");
                return;
            }
            userMessagesSeen.incrementAndGet();
            synchronized (msgs) {
                msgs.get(sid).add(userMsg(sid, text));
            }
            if (messageDelayMs > 0) {
                Thread.sleep(messageDelayMs);
            }
            JSONObject err = null;
            if (b.equals("provider-error")) {
                err = new JSONObject().put("name", "APIError").put("data", new JSONObject().put("message", "Rate limit reached for this free model"));
            } else if (b.equals("model-error")) {
                err = new JSONObject().put("name", "ProviderModelNotFoundError").put("data", new JSONObject().put("message", "Model nope/nothing is not available"));
            }
            JSONObject a = assistantMsg(sid, true, err);
            synchronized (msgs) {
                msgs.get(sid).add(a);
            }
            send(ex, 200, a.toString());
        }
    }

    // ===================================================================== scripted Android host
    static final class FakeHost implements OpenCodeServer.Host {
        final Map<String, String> prefs = new HashMap<String, String>();
        volatile boolean termux = true, perm = true;
        volatile String project = null;
        final String password = "testpw-0123456789";
        final Fake fake;
        final int port;
        final AtomicInteger starts = new AtomicInteger(), stops = new AtomicInteger(), logs = new AtomicInteger(), probes = new AtomicInteger();
        final List<String> startArgs = Collections.synchronizedList(new ArrayList<String>());
        volatile String startMode = "ok";                 // ok | never | not-found | ws-denied | security | no-result | exit1
        volatile long startDelayMs = 0;
        volatile String stopMode = "stopped";             // stopped | not-ours | still-up
        volatile boolean ownershipVerified = false;
        final List<OpenCodeServer.Status> published = Collections.synchronizedList(new ArrayList<OpenCodeServer.Status>());
        volatile String probeOut = "OC_PATH=/x/opencode\nOC_EXEC=1\nOC_VERSION=1.18.33-termux\nWS=ok\n";
        volatile String probeError = null;
        volatile int probeExitCode = 0;

        FakeHost(Fake f, int port) {
            this.fake = f;
            this.port = port;
            prefs.put(OpenCodeServer.K_PORT, String.valueOf(port));
        }

        public boolean termuxInstalled() { return termux; }
        public boolean runCommandPermission() { return perm; }
        public synchronized String pref(String k, String d) { String v = prefs.get(k); return v == null ? d : v; }
        public synchronized void setPref(String k, String v) { prefs.put(k, v); }
        public String serverPassword() { return password; }
        public String activeProjectDir() { return project == null ? null : OpenCodeServer.TERMUX_HOME + "/OpenCodeProjects/" + project; }
        public void publish(OpenCodeServer.Status s) { published.add(s); }

        public OpenCodeServer.ScriptResult runScript(String script, String[] args, long timeoutMs) throws NativeBridge.BridgeException {
            if (script == OpenCodeServer.START_SCRIPT) {
                starts.incrementAndGet();
                startArgs.add(args[0] + "|" + args[1]);
                if (startMode.equals("security")) {
                    throw new NativeBridge.BridgeException("PERMISSION_DENIED", "Termux refused the request. Set allow-external-apps=true", "SecurityException");
                }
                if (startMode.equals("not-found")) return new OpenCodeServer.ScriptResult(true, 127, "", "OPENCODE_NOT_FOUND", null);
                if (startMode.equals("ws-denied")) return new OpenCodeServer.ScriptResult(true, 20, "", "WORKSPACE_INACCESSIBLE: " + args[0], null);
                if (startMode.equals("exit1")) return new OpenCodeServer.ScriptResult(true, 1, "", "boom", null);
                if (!startMode.equals("never")) {
                    fake.directory = args[0];
                    final long delay = startDelayMs;
                    final int p = port;
                    Thread t = new Thread(new Runnable() {
                        public void run() {
                            try {
                                Thread.sleep(delay);
                                if (!fake.up()) fake.start(p);
                            } catch (Exception ignored) {
                            }
                        }
                    });
                    t.start();
                }
                return startMode.equals("no-result") ? new OpenCodeServer.ScriptResult(false, -1, "", "", "no result from Termux") : new OpenCodeServer.ScriptResult(true, 0, "LAUNCHED pid=1", "", null);
            }
            if (script == OpenCodeServer.OWNERSHIP_SCRIPT) {
                if (ownershipVerified && fake.up() && fake.directory.equals(args[1])) {
                    return new OpenCodeServer.ScriptResult(true, 0, "OWNED_PID=123\nOWNED_CWD=" + fake.directory + "\n", "", null);
                }
                return new OpenCodeServer.ScriptResult(true, 0, "NOT_OWNED\n", "", null);
            }
            if (script == OpenCodeServer.STOP_SCRIPT) {
                stops.incrementAndGet();
                if (stopMode.equals("not-ours")) return new OpenCodeServer.ScriptResult(true, 4, "NOT_OURS: python other.py", "", null);
                if (stopMode.equals("still-up")) return new OpenCodeServer.ScriptResult(true, 0, "STOPPED", "", null);
                fake.stop();
                return new OpenCodeServer.ScriptResult(true, 0, "STOPPED", "", null);
            }
            if (script == OpenCodeServer.LOG_SCRIPT) {
                logs.incrementAndGet();
                return new OpenCodeServer.ScriptResult(true, 0, "error: listen EADDRINUSE or boom, password=" + password, "", null);
            }
            if (script == OpenCodeServer.PROBE_SCRIPT) {
                probes.incrementAndGet();
                return new OpenCodeServer.ScriptResult(true, probeExitCode, probeOut, probeError == null ? "" : probeError, probeError);
            }
            return new OpenCodeServer.ScriptResult(true, 0, "opencode/big-pickle\nopencode/exo-free\n", "", null);   // `opencode models` script
        }
    }

    static OpenCodeServer.Settings fast() {
        OpenCodeServer.Settings s = new OpenCodeServer.Settings();
        s.startupTimeoutMs = 2500;
        s.pollMinMs = 40;
        s.pollMaxMs = 150;
        s.cooldownMs = 400;
        s.launchTimeoutMs = 3000;
        s.idleWindowMs = 500;
        return s;
    }

    static OpenCodeServer.ClientFactory factory() {
        return new OpenCodeServer.ClientFactory() {
            public OpenCodeClient create(int port, String password) { return new OpenCodeClient(port, password); }
        };
    }

    static final class Rig {
        final Fake fake = new Fake();
        final FakeHost host;
        final OpenCodeServer server;
        final OpenCodeAgent agent;
        final int port;

        Rig(boolean serverUp) throws Exception {
            port = freePort();
            host = new FakeHost(fake, port);
            if (serverUp) {
                fake.start(port);
            }
            server = new OpenCodeServer(host, factory(), fast());
            agent = new OpenCodeAgent(server, host);
        }

        void close() {
            fake.stop();
        }
    }

    static boolean waitFor(java.util.concurrent.Callable<Boolean> c, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (c.call()) return true;
            Thread.sleep(25);
        }
        return c.call();
    }

    static String waitTask(final OpenCodeAgent agent, final String sid, long ms) throws Exception {
        waitFor(new java.util.concurrent.Callable<Boolean>() {
            public Boolean call() { OpenCodeAgent.Task t = agent.task(sid); return t != null && !OpenCodeAgent.S_RUNNING.equals(t.state); }
        }, ms);
        return agent.task(sid).state;
    }

    // ===================================================================== main
    public static void main(String[] args) throws Exception {
        // ---------- pure logic
        test("workspace validation: traversal, odd chars, outside areas, whole storage", new Case() {
            public void run() throws Exception {
                for (String bad : new String[]{"/storage/emulated/0/../../data", "/storage/emulated/0/a/./b", "relative/dir", "", "/storage/emulated/0/a;rm -rf x", "/storage/emulated/0/a\nb",
                        "/storage/emulated/0/a$(id)", "/storage/emulated/0/a`id`", "/etc", "/data/data/other.app/files", "/storage/emulated/0", "/storage/emulated/0/", OpenCodeServer.TERMUX_HOME, "/storage/emulated/0//x"}) {
                    try {
                        OpenCodeServer.validateWorkspace(bad);
                        check(false, "should reject: " + bad.replace("\n", "\\n"));
                    } catch (NativeBridge.BridgeException e) {
                        check("WORKSPACE_INVALID".equals(e.code), "code for " + bad);
                    }
                }
                check(OpenCodeServer.validateWorkspace("/storage/emulated/0/Download/opencode-si/").equals("/storage/emulated/0/Download/opencode-si"), "trailing slash trimmed");
                check(OpenCodeServer.validateWorkspace("/sdcard/Download/My Project").equals("/sdcard/Download/My Project"), "sdcard + space accepted");
                check(OpenCodeServer.validateWorkspace(OpenCodeServer.TERMUX_HOME + "/OpenCodeProjects/demo").length() > 0, "termux project accepted");
                check(OpenCodeServer.normPath("/sdcard/Download/x").equals("/storage/emulated/0/Download/x"), "sdcard normalised");
                check(OpenCodeServer.normPath(OpenCodeServer.TERMUX_HOME + "/storage/shared/Download/x/").equals("/storage/emulated/0/Download/x"), "termux storage link normalised");
            }
        });

        test("SAF folder mapping only accepts primary storage", new Case() {
            public void run() {
                check("/storage/emulated/0/Download/opencode-si".equals(NativeBridge.folderFromTreeDocId("primary:Download/opencode-si")), "primary");
                check(NativeBridge.folderFromTreeDocId("1234-ABCD:Projects") == null, "sd card refused");
                check(NativeBridge.folderFromTreeDocId(null) == null && NativeBridge.folderFromTreeDocId("nocolon") == null, "garbage refused");
            }
        });

        test("base64 matches java.util.Base64; error text extraction; message-log description", new Case() {
            public void run() throws Exception {
                for (String s : new String[]{"", "a", "ab", "abc", "opencode:pw-with~chars.123", "\u00e9\u00e8"}) {
                    check(OpenCodeClient.base64(s.getBytes(UTF8)).equals(java.util.Base64.getEncoder().encodeToString(s.getBytes(UTF8))), "base64 of " + s);
                }
                check(OpenCodeClient.errorText("{\"error\":{\"data\":{\"message\":\"quota\"}}}").equals("quota"), "nested error");
                check(OpenCodeClient.errorText("<html>bad gateway</html>").contains("bad gateway"), "raw snippet");
                JSONArray log = new JSONArray().put(new JSONObject("{\"info\":{\"role\":\"user\"},\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}"))
                        .put(new JSONObject("{\"info\":{\"role\":\"assistant\",\"time\":{\"completed\":5}},\"parts\":[{\"type\":\"tool\",\"tool\":\"edit\",\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"a.js\"}}},"
                                + "{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"error\",\"error\":\"exit 2\",\"input\":{\"command\":\"npm test\"}}},{\"type\":\"tool\",\"tool\":\"read\",\"state\":{\"status\":\"running\",\"input\":{\"filePath\":\"b.js\"}}},{\"type\":\"text\",\"text\":\"All done\"}]}"));
                JSONObject d = OpenCodeAgent.describe(log, 0);
                check(d.optJSONArray("steps").length() == 3, "3 steps");
                check("write".equals(d.optJSONArray("steps").optJSONObject(0).optString("tool")), "edit -> write class");
                check(!d.optJSONArray("steps").optJSONObject(1).optBoolean("ok", true) && d.optJSONArray("steps").optJSONObject(1).optBoolean("done"), "failed command is done+not ok");
                check(!d.optJSONArray("steps").optJSONObject(2).optBoolean("done", true), "running tool not done");
                check(d.optJSONArray("changes").length() == 1 && "a.js".equals(d.optJSONArray("changes").optJSONObject(0).optString("path")), "only successful writes are changes");
                check(d.optJSONArray("summary").toString().contains("FAILED"), "summary states the failure");
                check(d.optBoolean("completed") && "All done".equals(d.optString("reply")), "completed + reply");
            }
        });

        // ---------- A: already running
        test("A server already running: connect, no duplicate launch, nothing killed", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY, "READY, was " + s.state + " " + s.message);
                    check(r.host.starts.get() == 0 && r.server.launchCount() == 0, "no launch");
                    check(!s.managed, "not marked as started by this app");
                    check("1.18.33-termux".equals(s.version), "version from health");
                    check(r.host.stops.get() == 0, "nothing stopped");
                    check(s.detail != null && s.detail.contains("did not start"), "tells that the server is external");
                } finally { r.close(); }
            }
        });

        // ---------- B: stopped -> start
        test("B server stopped: starts through Termux, waits for REAL health, becomes READY, managed", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                r.host.startDelayMs = 300;
                try {
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY, "READY, was " + s.state + " " + s.message + " " + s.detail);
                    check(r.host.starts.get() == 1, "exactly one launch");
                    check(s.managed, "managed by this app");
                    check(r.host.startArgs.get(0).equals(OpenCodeServer.DEFAULT_WORKSPACE + "|" + r.port), "launched in the default workspace on the configured port: " + r.host.startArgs);
                    boolean sawStarting = false, sawWaiting = false, sawChecking = false;
                    for (OpenCodeServer.Status p : r.host.published) {
                        sawStarting |= p.state == OpenCodeServer.State.STARTING_SERVER;
                        sawWaiting |= p.state == OpenCodeServer.State.WAITING_FOR_HEALTH;
                        sawChecking |= p.state == OpenCodeServer.State.CHECKING_SERVER;
                    }
                    check(sawChecking && sawStarting && sawWaiting, "state model walked through CHECKING_SERVER, STARTING_SERVER, WAITING_FOR_HEALTH");
                    check("1".equals(r.host.pref(OpenCodeServer.K_MANAGED, "0")), "ownership recorded");
                } finally { r.close(); }
            }
        });

        // ---------- C / D
        test("C Termux missing: clear setup state, nothing launched", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                r.host.termux = false;
                OpenCodeServer.Status s = r.server.ensureReady(true, false);
                check(s.state == OpenCodeServer.State.NOT_CONFIGURED && "TERMUX_MISSING".equals(s.code), "got " + s.state + " " + s.code);
                check(s.message.toLowerCase().contains("install"), "tells how to fix");
                check(r.host.starts.get() == 0, "no launch");
            }
        });
        test("C2 Termux missing but a server is reachable: still usable", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.host.termux = false;
                    check(r.server.ensureReady(true, false).state == OpenCodeServer.State.READY, "READY without Termux when a server answers");
                } finally { r.close(); }
            }
        });
        test("D RUN_COMMAND permission missing: names the permission; Android refusal (external apps off) is surfaced", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                r.host.perm = false;
                OpenCodeServer.Status s = r.server.ensureReady(true, false);
                check(s.state == OpenCodeServer.State.NOT_CONFIGURED && "PERMISSION_MISSING".equals(s.code) && s.message.contains("RUN_COMMAND"), "got " + s.code + " " + s.message);
                check(r.host.starts.get() == 0, "no launch");
                r.host.perm = true;
                r.host.startMode = "security";
                OpenCodeServer.Status s2 = r.server.ensureReady(true, true);
                check(s2.state == OpenCodeServer.State.NOT_CONFIGURED && "PERMISSION_DENIED".equals(s2.code) && s2.message.contains("allow-external-apps"), "got " + s2.code + " " + s2.message);
                check(s2.state != OpenCodeServer.State.READY, "a refused command is never reported as success");
            }
        });

        // ---------- E: fails to start
        test("E start fails: bounded timeout, diagnostics with server log, password scrubbed, no endless retry", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                r.host.startMode = "never";
                long t0 = System.currentTimeMillis();
                OpenCodeServer.Status s = r.server.ensureReady(true, false);
                long took = System.currentTimeMillis() - t0;
                check(s.state == OpenCodeServer.State.CONNECTION_FAILED && "STARTUP_TIMEOUT".equals(s.code), "got " + s.state + " " + s.code);
                check(took >= 2400 && took < 6000, "bounded wait, took " + took);
                check(r.host.starts.get() == 1, "one launch only, got " + r.host.starts.get());
                check(s.detail != null && s.detail.contains("EADDRINUSE"), "log tail attached");
                String all = String.valueOf(s.detail) + r.server.diagnostics();
                check(!all.contains(r.host.password), "password never in diagnostics");
                check(r.host.logs.get() == 1, "log read once");
                // cool-down: an automatic re-check right after does NOT launch again
                OpenCodeServer.Status again = r.server.ensureReady(true, false);
                check(r.host.starts.get() == 1, "cool-down prevents a retry storm, starts=" + r.host.starts.get());
                check(again.state == OpenCodeServer.State.CONNECTION_FAILED, "still failed");
                // explicit user retry is allowed
                r.host.startMode = "ok";
                OpenCodeServer.Status forced = r.server.ensureReady(true, true);
                check(forced.state == OpenCodeServer.State.READY && r.host.starts.get() == 2, "user retry works: " + forced.state);
                r.close();
            }
        });
        test("E2 Termux reports the script failed: specific, actionable codes", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                r.host.startMode = "not-found";
                OpenCodeServer.Status s = r.server.ensureReady(true, true);
                check("OPENCODE_NOT_FOUND".equals(s.code) && s.state == OpenCodeServer.State.NOT_CONFIGURED, "not found: " + s.code);
                r.host.startMode = "ws-denied";
                s = r.server.ensureReady(true, true);
                check("WORKSPACE_INACCESSIBLE".equals(s.code) && s.message.contains("termux-setup-storage"), "workspace: " + s.code + " " + s.message);
                r.host.startMode = "exit1";
                s = r.server.ensureReady(true, true);
                check("START_FAILED".equals(s.code) && String.valueOf(s.detail).contains("boom"), "generic: " + s.code);
                check(r.server.launchCount() == 3, "one launch per explicit attempt");
            }
        });
        test("E3 no result from Termux is NOT treated as failure or success: the server health decides", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                try {
                    r.host.startMode = "no-result";
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY, "server did come up: " + s.state);
                    r.fake.stop();
                    Rig r2 = new Rig(false);
                    r2.host.startMode = "never";
                    check(r2.host.starts.get() == 0, "sanity");
                } finally { r.close(); }
            }
        });

        // ---------- F / I / L / P: slow start + concurrency
        test("F/I slow start with 8 concurrent callers (resume, recreated Activity, messages): ONE launch, all see READY", new Case() {
            public void run() throws Exception {
                final Rig r = new Rig(false);
                r.host.startDelayMs = 900;
                try {
                    final CountDownLatch go = new CountDownLatch(1);
                    final List<OpenCodeServer.Status> res = Collections.synchronizedList(new ArrayList<OpenCodeServer.Status>());
                    List<Thread> ts = new ArrayList<Thread>();
                    for (int i = 0; i < 8; i++) {
                        Thread t = new Thread(new Runnable() {
                            public void run() {
                                try { go.await(); } catch (InterruptedException ignored) { }
                                res.add(r.server.ensureReady(true, false));
                            }
                        });
                        t.start();
                        ts.add(t);
                    }
                    go.countDown();
                    for (Thread t : ts) t.join(20000);
                    check(res.size() == 8, "all callers returned");
                    for (OpenCodeServer.Status s : res) check(s.state == OpenCodeServer.State.READY, "READY for each caller, was " + s.state);
                    check(r.host.starts.get() == 1 && r.server.launchCount() == 1, "exactly one launch, got " + r.host.starts.get());
                    // a "new Activity" asks again: reuses
                    check(r.server.ensureReady(true, false).state == OpenCodeServer.State.READY && r.host.starts.get() == 1, "still one launch");
                } finally { r.close(); }
            }
        });

        // ---------- G: port conflict
        test("G port occupied by something else: PORT_CONFLICT, nothing killed, nothing launched", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                HttpServer other = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), r.port), 0);
                other.createContext("/", new HttpHandler() {
                    public void handle(HttpExchange ex) throws IOException {
                        byte[] b = "<html>my web app</html>".getBytes(UTF8);
                        ex.sendResponseHeaders(200, b.length);
                        ex.getResponseBody().write(b);
                        ex.close();
                    }
                });
                other.start();
                try {
                    OpenCodeServer.Status s = r.server.ensureReady(true, true);
                    check(s.state == OpenCodeServer.State.CONNECTION_FAILED && "PORT_CONFLICT".equals(s.code), "got " + s.state + " " + s.code);
                    check(r.host.starts.get() == 0 && r.host.stops.get() == 0, "no launch, no kill");
                    check(s.message.contains("Nothing was stopped"), "says nothing was stopped");
                } finally { other.stop(0); }
                // a socket that accepts and hangs up
                final ServerSocket raw = new ServerSocket(freePort(), 1, InetAddress.getByName("127.0.0.1"));
                Thread acc = new Thread(new Runnable() { public void run() { try { while (true) raw.accept().close(); } catch (IOException ignored) { } } });
                acc.setDaemon(true);
                acc.start();
                Rig r2 = new Rig(false);
                r2.host.prefs.put(OpenCodeServer.K_PORT, String.valueOf(raw.getLocalPort()));
                OpenCodeServer.Status s2 = r2.server.ensureReady(true, true);
                check("PORT_CONFLICT".equals(s2.code) && r2.host.starts.get() == 0, "raw socket: " + s2.code);
                raw.close();
            }
        });

        // ---------- auth
        test("authentication: password enforced / wrong password / anonymous exposure reported", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.fake.password = r.host.password;
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY && Boolean.TRUE.equals(s.authEnforced), "READY with auth enforced, authEnforced=" + s.authEnforced);
                    r.fake.password = "somebody-elses-password";
                    OpenCodeServer.Status s2 = r.server.ensureReady(true, false);
                    check(s2.state == OpenCodeServer.State.AUTHENTICATION_FAILED, "wrong password -> AUTHENTICATION_FAILED, was " + s2.state);
                    check(r.host.starts.get() == 0, "never launches a second server over an authenticated one");
                    r.fake.password = null;
                    OpenCodeServer.Status s3 = r.server.ensureReady(true, false);
                    check(s3.state == OpenCodeServer.State.READY && Boolean.FALSE.equals(s3.authEnforced) && String.valueOf(s3.detail).contains("without a password"), "open server flagged: " + s3.detail);
                } finally { r.close(); }
            }
        });

        // ---------- workspace (M)
        test("M workspace: wrong folder on a foreign server is refused; our own server restarts for a new folder; busy blocks the restart", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.fake.directory = "/storage/emulated/0/Download/other-project";
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.CONNECTION_FAILED && "WORKSPACE_MISMATCH".equals(s.code), "foreign server for another folder: " + s.code);
                    check(r.host.stops.get() == 0 && r.host.starts.get() == 0, "foreign server untouched");
                    r.fake.directory = "/sdcard/Download/opencode-si";
                    check(r.server.ensureReady(true, false).state == OpenCodeServer.State.READY, "equivalent spelling (/sdcard) accepted");
                } finally { r.close(); }
                Rig m = new Rig(false);
                try {
                    check(m.server.ensureReady(true, false).state == OpenCodeServer.State.READY && m.host.starts.get() == 1, "own server up");
                    m.host.prefs.put(OpenCodeServer.K_WS, "/storage/emulated/0/Download/second");
                    // busy: refuse to restart under a running task
                    m.server.taskCounter().incrementAndGet();
                    OpenCodeServer.Status busy = m.server.ensureReady(true, false);
                    check("WORKSPACE_BUSY".equals(busy.code) && m.host.stops.get() == 0, "busy: " + busy.code);
                    m.server.taskCounter().decrementAndGet();
                    OpenCodeServer.Status moved = m.server.ensureReady(true, false);
                    check(moved.state == OpenCodeServer.State.READY && m.host.stops.get() == 1 && m.host.starts.get() == 2, "restarted for new folder: " + moved.state + " " + moved.message);
                    check(m.host.startArgs.get(1).startsWith("/storage/emulated/0/Download/second|"), "agent now works in the selected directory: " + m.host.startArgs);
                    check(m.fake.directory.equals("/storage/emulated/0/Download/second"), "server reports the new directory");
                    check(m.server.workspaceChanged() == false, "no pending change");
                    m.host.prefs.put(OpenCodeServer.K_MODE, OpenCodeServer.MODE_PROJECT);
                    check(m.server.workspaceChanged(), "project mode with no project open = change/problem");
                    check("WORKSPACE_INVALID".equals(m.server.ensureReady(true, false).code), "no project: refused, not silently falling back to another folder");
                } finally { m.close(); }
            }
        });

        // ---------- stop policy
        test("stop policy: foreign server never stopped; running task blocks; foreign process id never killed", new Case() {
            public void run() throws Exception {
                Rig ext = new Rig(true);
                try {
                    ext.server.ensureReady(true, false);
                    try { ext.server.stopManaged(true); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("NOT_MANAGED".equals(e.code), "NOT_MANAGED " + e.code); }
                    check(ext.host.stops.get() == 0, "no stop script run");
                } finally { ext.close(); }
                Rig r = new Rig(false);
                try {
                    r.server.ensureReady(true, false);
                    r.server.taskCounter().incrementAndGet();
                    try { r.server.stopManaged(false); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("TASK_RUNNING".equals(e.code), "TASK_RUNNING " + e.code); }
                    r.server.taskCounter().decrementAndGet();
                    r.host.stopMode = "not-ours";
                    OpenCodeServer.Status s = r.server.stopManaged(false);
                    check("NOT_OURS".equals(s.code), "script says not ours: " + s.code);
                    check(!"1".equals(r.host.pref(OpenCodeServer.K_MANAGED, "0")), "stale ownership record dropped");
                    check(r.fake.up(), "server left running");
                } finally { r.close(); }
                Rig q = new Rig(false);
                try {
                    q.server.ensureReady(true, false);
                    OpenCodeServer.Status st = q.server.stopManaged(false);
                    check(st.state == OpenCodeServer.State.SERVER_STOPPED && !q.fake.up() && q.host.stops.get() == 1, "stopped cleanly: " + st.state);
                    check(q.server.recheck().state == OpenCodeServer.State.SERVER_STOPPED, "recheck keeps SERVER_STOPPED");
                } finally { q.close(); }
            }
        });

        test("workspace switch: recover only a PID-file-verified server after app state was lost", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.fake.directory = OpenCodeServer.TERMUX_HOME + "/OpenCodeProjects/dd";
                    r.host.project = "new1";
                    r.host.prefs.put(OpenCodeServer.K_MODE, OpenCodeServer.MODE_PROJECT);
                    r.host.ownershipVerified = true;
                    // Simulate app preferences being lost while the app-launched Termux process survives.
                    r.host.prefs.put(OpenCodeServer.K_MANAGED, "0");
                    OpenCodeServer.Status s = r.server.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY, "recovers and switches workspace: " + s.code + " " + s.message);
                    check(r.host.stops.get() == 1 && r.host.starts.get() == 1, "only verified app-owned server stopped and restarted");
                    check(r.fake.directory.equals(r.host.activeProjectDir()), "server ends in selected project");
                } finally { r.close(); }
            }
        });

        // ---------- O: force-stopped app / process restart
        test("O app reopened after force-stop: new manager instance reuses a healthy managed server, restarts a dead one", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(false);
                try {
                    r.server.ensureReady(true, false);
                    OpenCodeServer second = new OpenCodeServer(r.host, factory(), fast());       // new process, same persisted prefs
                    OpenCodeServer.Status s = second.ensureReady(true, false);
                    check(s.state == OpenCodeServer.State.READY && s.managed && r.host.starts.get() == 1, "reused, still managed, no second launch");
                    r.fake.stop();                                                                // Android killed Termux's process meanwhile
                    OpenCodeServer.Status s2 = second.recheck();
                    check(s2.state == OpenCodeServer.State.SERVER_STOPPED || second.status().state == OpenCodeServer.State.SERVER_STOPPED, "death detected: " + s2.state);
                    OpenCodeServer.Status s3 = second.ensureReady(true, true);
                    check(s3.state == OpenCodeServer.State.READY && r.host.starts.get() == 2, "recovered with one new launch");
                } finally { r.close(); }
            }
        });

        // ---------- agent layer
        test("J/P long task: UI-visible RUNNING with live steps, second message refused while busy, no timeout, then SUCCESS", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.fake.messageDelayMs = 1800;
                    String sid = r.agent.startSession();
                    JSONObject acc = r.agent.send(sid, "add a test");
                    check(acc.optBoolean("accepted"), "accepted immediately (non-blocking)");
                    check(r.server.activeTasks() == 1, "task counted");
                    try { r.agent.send(sid, "second"); check(false, "must refuse while running"); } catch (NativeBridge.BridgeException e) { check("TASK_RUNNING".equals(e.code), "TASK_RUNNING"); }
                    JSONObject st = r.agent.status(sid);
                    check("RUNNING".equals(st.optString("state")), "RUNNING while in flight: " + st.optString("state"));
                    check(waitTask(r.agent, sid, 10000).equals("SUCCESS"), "finishes SUCCESS");
                    JSONObject done = r.agent.status(sid);
                    check("SUCCESS".equals(done.optString("state")) && "Done.".equals(done.optString("reply")), "reply from the server: " + done);
                    check(done.optJSONArray("changes").length() == 1, "real change list");
                    check(r.server.activeTasks() == 0, "counter back to 0");
                    check(r.fake.userMessagesSeen.get() == 1, "exactly one message sent");
                    // J: next message on the same session works and is a separate turn
                    r.fake.messageDelayMs = 0;
                    r.agent.send(sid, "and another");
                    check(waitTask(r.agent, sid, 5000).equals("SUCCESS") && r.fake.userMessagesSeen.get() == 2, "second message: separate turn");
                    JSONObject second = r.agent.status(sid);
                    check(second.optJSONArray("steps").length() == 2, "steps only from the second turn: " + second.optJSONArray("steps").length());
                } finally { r.close(); }
            }
        });
        test("K provider rejects: the REAL provider error is shown; L unavailable model is reported, not faked", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    String sid = r.agent.startSession();
                    r.fake.behavior = "provider-error";
                    r.agent.send(sid, "do it");
                    check(waitTask(r.agent, sid, 5000).equals("FAILED"), "FAILED");
                    JSONObject st = r.agent.status(sid);
                    check(st.optJSONObject("error").optString("message").contains("Rate limit reached"), "real message: " + st.optJSONObject("error"));
                    check(st.optString("reply").length() == 0, "no fabricated reply");
                    r.fake.behavior = "model-error";
                    r.agent.send(sid, "again");
                    check(waitTask(r.agent, sid, 5000).equals("FAILED"), "FAILED");
                    JSONObject st2 = r.agent.status(sid);
                    check("MODEL_UNAVAILABLE".equals(st2.optJSONObject("error").optString("code")), "model code: " + st2.optJSONObject("error"));
                    r.fake.behavior = "http500";
                    r.agent.send(sid, "again 2");
                    check(waitTask(r.agent, sid, 5000).equals("FAILED"), "FAILED on HTTP 500");
                    check(r.agent.status(sid).optJSONObject("error").optString("message").contains("upstream exploded"), "HTTP error text passed through");
                } finally { r.close(); }
            }
        });
        test("model selection: dynamic list, unknown model refused, auto leaves the agent's own choice, selection sent", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    JSONObject m = r.agent.models();
                    check("server".equals(m.optString("source")) && m.optJSONArray("models").length() == 2, "from the server: " + m);
                    check("opencode/big-pickle".equals(m.optJSONArray("models").optJSONObject(0).optString("id")), "provider/model ids");
                    try { r.agent.setModel("opencode/not-offered"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("MODEL_UNAVAILABLE".equals(e.code), "refused " + e.code); }
                    try { r.agent.setModel("../etc/passwd"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("INVALID_ARGUMENT".equals(e.code), "invalid " + e.code); }
                    String sid = r.agent.startSession();
                    r.agent.send(sid, "no override");
                    waitTask(r.agent, sid, 5000);
                    check(!r.fake.bodies.get(0).contains("\"model\""), "auto: no model field sent, OpenCode's configured model applies: " + r.fake.bodies.get(0));
                    r.agent.setModel("opencode/exo-free");
                    r.agent.send(sid, "override");
                    waitTask(r.agent, sid, 5000);
                    check(r.fake.bodies.get(1).contains("\"providerID\":\"opencode\"") && r.fake.bodies.get(1).contains("\"modelID\":\"exo-free\""), "selected model sent: " + r.fake.bodies.get(1));
                    // list falls back to the installed CLI when the server has no providers route
                    r.fake.providersRoute = false;
                    JSONObject cli = r.agent.models();
                    check("cli".equals(cli.optString("source")) && cli.optJSONArray("models").length() == 2, "CLI fallback: " + cli);
                } finally { r.close(); }
            }
        });
        test("Plan mode: sends its own agent only for Plan; refuses a server that provably has none", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    String sid = r.agent.startSession();
                    r.agent.send(sid, "build it");
                    waitTask(r.agent, sid, 5000);
                    check(!r.fake.bodies.get(r.fake.bodies.size() - 1).contains("\"agent\""), "Build sends no agent override: " + r.fake.bodies.get(r.fake.bodies.size() - 1));
                    r.agent.send(sid, "plan it", "plan");
                    waitTask(r.agent, sid, 5000);
                    check(r.fake.bodies.get(r.fake.bodies.size() - 1).contains("\"agent\":\"plan\""), "Plan is carried in the body: " + r.fake.bodies.get(r.fake.bodies.size() - 1));
                    r.fake.agentsJson = "[{\"id\":\"build\"}]";
                    int before = r.fake.bodies.size();
                    try { r.agent.send(sid, "plan please", "plan"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("AGENT_UNAVAILABLE".equals(e.code), "refused: " + e.code); }
                    check(r.fake.bodies.size() == before, "nothing was sent when the plan agent is unavailable");
                    r.fake.agentsJson = "[{\"id\":\"build\"},{\"id\":\"plan\"}]";
                    r.agent.send(sid, "plan ok", "plan");
                    waitTask(r.agent, sid, 5000);
                    check(r.fake.bodies.get(r.fake.bodies.size() - 1).contains("\"agent\":\"plan\""), "sent once plan is confirmed");
                    int before2 = r.fake.bodies.size();
                    try { r.agent.send(sid, "x", "yolo"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("INVALID_ARGUMENT".equals(e.code), "unknown mode: " + e.code); }
                    check(r.fake.bodies.size() == before2, "an unknown mode never reaches the server");
                } finally { r.close(); }
            }
        });
        test("H/N connection drops: never double-sends; re-sends only when provably not received; UNCERTAIN otherwise", new Case() {
            public void run() throws Exception {
                // 1) dropped before the server recorded the message -> exactly one re-send
                Rig a = new Rig(true);
                try {
                    String sid = a.agent.startSession();
                    a.fake.behavior = "drop-before";
                    a.fake.drops.set(1);
                    a.agent.send(sid, "task one");
                    check(waitTask(a.agent, sid, 8000).equals("SUCCESS"), "recovered: " + a.agent.task(sid).state);
                    check(a.fake.userMessagesSeen.get() == 1, "server saw the message exactly once, saw " + a.fake.userMessagesSeen.get());
                    check(a.fake.bodies.size() == 2, "two HTTP attempts, only one accepted");
                } finally { a.close(); }
                // 2) dropped after the server recorded it and finished -> SUCCESS read from the log, NO re-send
                Rig b = new Rig(true);
                try {
                    String sid = b.agent.startSession();
                    b.fake.behavior = "drop-after";
                    b.fake.drops.set(1);
                    b.agent.send(sid, "task two");
                    check(waitTask(b.agent, sid, 8000).equals("SUCCESS"), "log shows it completed: " + b.agent.task(sid).state);
                    check(b.fake.userMessagesSeen.get() == 1 && b.fake.bodies.size() == 1, "no duplicate send");
                } finally { b.close(); }
                // 3) dropped after the server recorded it but the run never finishes -> UNCERTAIN, no re-send, no fake success
                Rig c = new Rig(true);
                try {
                    String sid = c.agent.startSession();
                    c.fake.behavior = "drop-after-unfinished";
                    c.fake.drops.set(1);
                    c.agent.send(sid, "task three");
                    check(waitTask(c.agent, sid, 8000).equals("UNCERTAIN"), "UNCERTAIN, was " + c.agent.task(sid).state);
                    check(c.fake.userMessagesSeen.get() == 1 && c.fake.bodies.size() == 1, "still no duplicate");
                    JSONObject st = c.agent.status(sid);
                    check("OUTCOME_UNKNOWN".equals(st.optJSONObject("error").optString("code")), "explains the uncertainty: " + st.optJSONObject("error"));
                } finally { c.close(); }
                // 4) server dies mid-task and cannot be restarted -> UNCERTAIN (not FAILED, not SUCCESS)
                final Rig d = new Rig(true);
                try {
                    String sid = d.agent.startSession();
                    d.fake.messageDelayMs = 400;
                    d.host.startMode = "never";
                    d.agent.send(sid, "task four");
                    Thread.sleep(150);
                    d.fake.stop();
                    check(waitTask(d.agent, sid, 15000).equals("UNCERTAIN"), "UNCERTAIN, was " + d.agent.task(sid).state);
                    check(d.agent.status(sid).optJSONObject("error").optString("code").equals("SERVER_LOST") || d.agent.status(sid).optJSONObject("error").optString("code").equals("OUTCOME_UNKNOWN"), "lost-server explanation");
                    check(d.server.activeTasks() == 0, "counter released");
                } finally { d.close(); }
                // 5) server dies and IS restarted by the app, session survives (sessions are server-side) -> can continue
                Rig e = new Rig(true);
                try {
                    String sid = e.agent.startSession();
                    e.fake.behavior = "drop-before";
                    e.fake.drops.set(1);
                    e.fake.stop();                                            // down before the first attempt
                    e.host.startDelayMs = 100;
                    e.agent.send(sid, "task five");                           // send() recovers the server first (ensureReady)
                    check(waitTask(e.agent, sid, 15000).equals("SUCCESS"), "restart + session continuation: " + e.agent.task(sid).state + " " + e.agent.task(sid).error);
                    check(e.host.starts.get() == 1, "restarted exactly once");
                } finally { e.close(); }
            }
        });
        test("cancel: only claims cancellation when the server accepted abort; unsupported route is reported honestly", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    String sid = r.agent.startSession();
                    r.fake.messageDelayMs = 1500;
                    r.agent.send(sid, "long one");
                    Thread.sleep(150);
                    JSONObject c = r.agent.cancel(sid);
                    check(c.optBoolean("cancelRequested") && r.fake.aborts.get() == 1, "abort sent to the server");
                    waitTask(r.agent, sid, 6000);
                    check("CANCELLED".equals(r.agent.task(sid).state), "state CANCELLED after the run ended: " + r.agent.task(sid).state);
                    r.fake.abortRoute = false;
                    r.agent.send(sid, "another long one");
                    Thread.sleep(150);
                    try { r.agent.cancel(sid); check(false, "must fail"); } catch (NativeBridge.BridgeException e) { check("OPENCODE_UNSUPPORTED".equals(e.code), "unsupported reported: " + e.code); }
                    waitTask(r.agent, sid, 6000);
                    check("SUCCESS".equals(r.agent.task(sid).state), "task not mislabelled as cancelled");
                    try { r.agent.cancel(sid); check(false, "nothing running"); } catch (NativeBridge.BridgeException e) { check("NOT_RUNNING".equals(e.code), "NOT_RUNNING"); }
                } finally { r.close(); }
            }
        });
        test("status after an app restart (no task record): derived from the server log, never assumed", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    String sid = r.agent.startSession();
                    r.agent.send(sid, "x");
                    waitTask(r.agent, sid, 5000);
                    OpenCodeAgent fresh = new OpenCodeAgent(r.server, r.host);                    // new process: empty registry
                    JSONObject st = fresh.status(sid);
                    check("SUCCESS".equals(st.optString("state")), "finished run recognised: " + st.optString("state"));
                    String sid2 = r.agent.startSession();
                    JSONObject empty = fresh.status(sid2);
                    check("UNCERTAIN".equals(empty.optString("state")), "no evidence -> UNCERTAIN, was " + empty.optString("state"));
                } finally { r.close(); }
            }
        });
        test("unknown session id is rejected and never reaches the URL path", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    try { r.agent.send("../../etc", "x"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("INVALID_ARGUMENT".equals(e.code), "invalid id " + e.code); }
                    try { r.agent.send("ses_does_not_exist", "x"); check(false, "must refuse"); } catch (NativeBridge.BridgeException e) { check("SESSION_NOT_FOUND".equals(e.code), "not found " + e.code); }
                } finally { r.close(); }
            }
        });

        // ---------- setup wizard
        test("setup wizard checks: every item real, status honest", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    JSONArray c = r.server.setupChecks();
                    Map<String, String> m = new HashMap<String, String>();
                    for (int i = 0; i < c.length(); i++) m.put(c.optJSONObject(i).optString("key"), c.optJSONObject(i).optString("status"));
                    for (String k : new String[]{"termux_app", "run_command_permission", "workspace_setting", "external_apps", "opencode_found", "opencode_runs", "opencode_version", "workspace_access", "server_running", "server_health", "provider_auth", "test_session"}) {
                        check(m.containsKey(k), "check present: " + k);
                    }
                    check("ok".equals(m.get("server_health")) && "ok".equals(m.get("test_session")) && "ok".equals(m.get("opencode_version")), "all ok: " + m);
                    check("1".equals(r.host.pref(OpenCodeServer.K_SETUP_DONE, "0")), "setup remembered only after success");
                    r.host.perm = false;
                    r.host.setPref(OpenCodeServer.K_SETUP_DONE, "0");
                    JSONArray c2 = r.server.setupChecks();
                    String perm = "";
                    for (int i = 0; i < c2.length(); i++) if ("run_command_permission".equals(c2.optJSONObject(i).optString("key"))) perm = c2.optJSONObject(i).optString("status");
                    check("failed".equals(perm) && "0".equals(r.host.pref(OpenCodeServer.K_SETUP_DONE, "0")), "missing permission fails the wizard");
                    r.host.perm = true;
                    r.host.probeOut = "OC_PATH=/x/opencode\nOC_EXEC=1\nOC_VERSION=2.0.0\nWS=missing\n";
                    JSONArray c3 = r.server.setupChecks();
                    String ver = "", ws = "";
                    for (int i = 0; i < c3.length(); i++) { JSONObject o = c3.optJSONObject(i); if ("opencode_version".equals(o.optString("key"))) ver = o.optString("status"); if ("workspace_access".equals(o.optString("key"))) ws = o.optString("status"); }
                    check("warning".equals(ver) && "failed".equals(ws), "untested version warns, missing folder fails: " + ver + "/" + ws);
                } finally { r.close(); }
            }
        });

        test("setup check does not treat a delivered Termux error as successful external-command access", new Case() {
            public void run() throws Exception {
                Rig r = new Rig(true);
                try {
                    r.host.probeError = "RunCommandService requires allow-external-apps property to be true";
                    r.host.probeExitCode = 1;
                    JSONArray checks = r.server.setupChecks();
                    String external = "", detail = "";
                    for (int i = 0; i < checks.length(); i++) {
                        JSONObject item = checks.optJSONObject(i);
                        if ("external_apps".equals(item.optString("key"))) { external = item.optString("status"); detail = item.optString("detail"); }
                    }
                    check("failed".equals(external), "external app error must fail even when a result was delivered: " + external);
                    check(detail.contains("allow-external-apps"), "diagnostic should name the blocked Termux setting: " + detail);
                } finally { r.close(); }
            }
        });

        // ---------- real bash scripts on real processes
        test("REAL Termux scripts under bash: start detached, pid file, health, auth, stop only ours, refuse foreign pid", new Case() {
            public void run() throws Exception {
                File base = java.nio.file.Files.createTempDirectory("ocsi").toFile();
                File home = new File(base, "home"), bin = new File(base, "usr/bin"), ws = new File(base, "ws");
                home.mkdirs(); bin.mkdirs(); ws.mkdirs();
                java.nio.file.Files.copy(new File("fixtures/fake-opencode.py").toPath(), new File(bin, "opencode").toPath());
                new File(bin, "opencode").setExecutable(true);
                final Map<String, String> env = new HashMap<String, String>();
                env.put("HOME", home.getAbsolutePath());
                env.put("PREFIX", new File(base, "usr").getAbsolutePath());
                env.put("PATH", bin.getAbsolutePath() + ":" + System.getenv("PATH"));
                int port = freePort();
                String pw = "realbash-pw-123456";

                OpenCodeServer.ScriptResult probe = bash(env, OpenCodeServer.PROBE_SCRIPT, ws.getAbsolutePath());
                check(probe.stdout.contains("OC_EXEC=1") && probe.stdout.contains("OC_VERSION=1.18.33-termux") && probe.stdout.contains("WS=ok"), "probe: " + probe.stdout);
                check(bash(env, OpenCodeServer.PROBE_SCRIPT, new File(base, "nope").getAbsolutePath()).stdout.contains("WS=missing"), "probe reports missing folder");

                OpenCodeServer.ScriptResult bad = bash(env, OpenCodeServer.START_SCRIPT, new File(base, "nope").getAbsolutePath(), String.valueOf(port), pw);
                check(bad.exitCode == 20 && bad.stderr.contains("WORKSPACE_INACCESSIBLE"), "inaccessible folder exit 20: " + bad.exitCode);
                Map<String, String> noOc = new HashMap<String, String>(env);
                noOc.put("PATH", "/usr/bin:/bin");
                noOc.put("PREFIX", new File(base, "empty").getAbsolutePath());
                check(bash(noOc, OpenCodeServer.START_SCRIPT, ws.getAbsolutePath(), String.valueOf(port), pw).exitCode == 127, "missing executable exit 127");

                long t0 = System.currentTimeMillis();
                OpenCodeServer.ScriptResult start = bash(env, OpenCodeServer.START_SCRIPT, ws.getAbsolutePath(), String.valueOf(port), pw);
                check(start.exitCode == 0 && start.stdout.contains("LAUNCHED"), "start: " + start.exitCode + " " + start.stdout + start.stderr);
                check(System.currentTimeMillis() - t0 < 5000, "start script returns promptly (server is detached)");
                File pidFile = new File(home, ".opencode-si/opencode-server.pid");
                check(pidFile.isFile(), "pid file written");

                OpenCodeClient anon = new OpenCodeClient(port, null), good = new OpenCodeClient(port, pw);
                check(waitFor(new java.util.concurrent.Callable<Boolean>() { public Boolean call() { return true; } }, 1) && waitHealth(good, 8000), "server healthy through the real client");
                check(anon.health().kind == OpenCodeClient.Health.Kind.AUTH, "password enforced by the launched server (OPENCODE_SERVER_PASSWORD passed via env)");
                check(Boolean.FALSE.equals(good.acceptsAnonymous()), "anonymous requests are refused");
                check(good.directory() != null && OpenCodeServer.normPath(good.directory()).endsWith(OpenCodeServer.normPath(ws.getCanonicalPath())) || good.directory().equals(ws.getCanonicalPath()), "server runs in the requested folder: " + good.directory());
                check(!new String(java.nio.file.Files.readAllBytes(new File(home, ".opencode-si/opencode-server.log").toPath()), UTF8).contains(pw), "password not written to the server log");

                // an unrelated process whose pid ends up in the pid file must survive
                Process other = new ProcessBuilder("sleep", "60").start();
                long otherPid = pidOf(other);
                String ours = new String(java.nio.file.Files.readAllBytes(pidFile.toPath()), UTF8);
                java.nio.file.Files.write(pidFile.toPath(), (otherPid + "\nsingle\n").getBytes(UTF8));
                OpenCodeServer.ScriptResult refuse = bash(env, OpenCodeServer.STOP_SCRIPT, String.valueOf(port));
                check(refuse.exitCode == 4 && refuse.stdout.contains("NOT_OURS"), "foreign pid refused: " + refuse.exitCode + " " + refuse.stdout);
                check(other.isAlive(), "the unrelated process was NOT killed");
                check(good.health().kind == OpenCodeClient.Health.Kind.OK, "our server untouched by the refused stop");
                java.nio.file.Files.write(pidFile.toPath(), ours.getBytes(UTF8));
                OpenCodeServer.ScriptResult stop = bash(env, OpenCodeServer.STOP_SCRIPT, String.valueOf(port));
                check(stop.exitCode == 0 && (stop.stdout.contains("STOPPED") || stop.stdout.contains("KILLED")), "stop: " + stop.stdout);
                check(waitFor(new java.util.concurrent.Callable<Boolean>() { public Boolean call() { return true; } }, 1) && waitDown(good, 6000), "server gone after stop");
                check(!pidFile.exists(), "pid file removed");
                check(other.isAlive(), "unrelated process still alive");
                other.destroy();
                check(bash(env, OpenCodeServer.STOP_SCRIPT, String.valueOf(port)).exitCode == 3, "stop without pid file is a no-op (exit 3)");
                // the shell fallback (no setsid) path
                File noSetsid = new File(base, "nosetsid");
                noSetsid.mkdirs();
            }
        });

        System.out.println();
        System.out.println(runs + " checks, " + fails + " failed");
        if (fails > 0) {
            System.exit(1);
        }
        System.exit(0);
    }

    static boolean waitHealth(final OpenCodeClient c, long ms) throws Exception {
        return waitFor(new java.util.concurrent.Callable<Boolean>() { public Boolean call() { return c.health().kind == OpenCodeClient.Health.Kind.OK; } }, ms);
    }

    static boolean waitDown(final OpenCodeClient c, long ms) throws Exception {
        return waitFor(new java.util.concurrent.Callable<Boolean>() { public Boolean call() { return c.health().kind == OpenCodeClient.Health.Kind.DOWN; } }, ms);
    }

    static long pidOf(Process p) throws Exception {
        try {
            java.lang.reflect.Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            return ((Number) f.get(p)).longValue();
        } catch (Exception e) {
            return (Long) Process.class.getMethod("pid").invoke(p);
        }
    }

    /** Runs a script exactly the way Termux does: bash -c SCRIPT opencode-si ARGS..., in a given environment. */
    static OpenCodeServer.ScriptResult bash(Map<String, String> env, String script, String... args) throws Exception {
        List<String> cmd = new ArrayList<String>();
        cmd.add("bash");
        cmd.add("-c");
        cmd.add(script);
        cmd.add("opencode-si");
        for (String a : args) cmd.add(a);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().clear();
        pb.environment().putAll(env);
        Process p = pb.start();
        p.getOutputStream().close();
        final Process fp = p;
        final StringBuilder err = new StringBuilder();
        Thread te = new Thread(new Runnable() { public void run() { try { err.append(Fake.read(fp.getErrorStream())); } catch (IOException ignored) { } } });
        te.start();
        String out = Fake.read(p.getInputStream());
        int code = p.waitFor();
        te.join(2000);
        return new OpenCodeServer.ScriptResult(true, code, out, err.toString(), null);
    }
}
