package com.opencode.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Client for the OFFICIAL OpenCode HTTP server (`opencode serve`), loopback only.
 *
 * Routes used, and how sure we are of them:
 *   VERIFIED by the owner on 1.18.33-termux: GET /global/health, POST /session (body {}), POST /session/{id}/message.
 *   Everything else (GET /path, GET /doc, GET /session, GET /session/{id}/message, POST /session/{id}/abort,
 *   GET /config/providers, GET /agent) follows OpenCode's published server docs and has NOT been run against
 *   1.18.33-termux from this build environment. Optional routes are therefore only called when the server's own
 *   OpenAPI document (GET /doc) lists them, or when that document could not be read; a missing route is reported
 *   as OPENCODE_UNSUPPORTED instead of being guessed.
 *
 * Authentication: if a password is supplied, requests carry HTTP Basic auth (user "opencode"), which is what the
 * server's OPENCODE_SERVER_PASSWORD option documents. Nothing here logs or returns the password.
 *
 * Timeouts are separate on purpose: connect (short), request (per call), and the agent run itself (sendMessage uses
 * NO read timeout: a coding task may legitimately run for a long time and is ended by the server, a failure or the user).
 */
final class OpenCodeClient {
    static final String HOST = "127.0.0.1";
    static final String USER = "opencode";
    static final Pattern ID_RE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$");
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int MAX_RESPONSE = 32 * 1024 * 1024;
    static final int CONNECT_MS = 2500;

    /** Result of a health probe. DOWN = nothing listens (connection refused). */
    static final class Health {
        enum Kind { OK, DOWN, AUTH, NOT_OPENCODE, ERROR }
        final Kind kind;
        final String version;
        final int http;
        final String detail;

        Health(Kind kind, String version, int http, String detail) {
            this.kind = kind;
            this.version = version;
            this.http = http;
            this.detail = detail;
        }
    }

    private static final class Raw {
        final int status;
        final String body;

        Raw(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private final int port;
    private final String authHeader;
    private volatile HttpURLConnection inflightSend;

    OpenCodeClient(int port, String password) {
        this.port = port;
        this.authHeader = password == null || password.length() == 0 ? null : "Basic " + base64((USER + ":" + password).getBytes(UTF8));
    }

    int port() {
        return port;
    }

    // ------------------------------------------------------------------ probes
    Health health() {
        try {
            Raw r = raw("GET", "/global/health", null, CONNECT_MS, 5000, true);
            if (r.status == 401 || r.status == 403) {
                return new Health(Health.Kind.AUTH, null, r.status, "The server requires credentials this app does not have.");
            }
            if (r.status == 200) {
                try {
                    JSONObject o = new JSONObject(r.body);
                    if (o.optBoolean("healthy", false) || o.has("version")) {
                        return new Health(Health.Kind.OK, o.optString("version", ""), 200, null);
                    }
                    return new Health(Health.Kind.NOT_OPENCODE, null, 200, "HTTP 200 but no OpenCode health fields: " + snippet(r.body));
                } catch (Exception notJson) {
                    return new Health(Health.Kind.NOT_OPENCODE, null, 200, "HTTP 200 but not JSON: " + snippet(r.body));
                }
            }
            return new Health(Health.Kind.NOT_OPENCODE, null, r.status, "HTTP " + r.status + " from /global/health: " + snippet(r.body));
        } catch (ConnectException e) {
            return new Health(Health.Kind.DOWN, null, 0, "connection refused");
        } catch (SocketTimeoutException e) {
            return new Health(Health.Kind.ERROR, null, 0, "timed out (something accepted the connection but did not answer)");
        } catch (IOException e) {
            return new Health(Health.Kind.ERROR, null, 0, e.getClass().getSimpleName());
        }
    }

    /** Directory the server operates in (GET /path), or null when this server does not report it. */
    String directory() throws NativeBridge.BridgeException {
        try {
            Raw r = raw("GET", "/path", null, CONNECT_MS, 8000, true);
            if (r.status == 404 || r.status == 405) {
                return null;
            }
            check(r, "GET /path");
            JSONObject o = new JSONObject(r.body);
            String d = o.optString("directory", "");
            if (d.length() == 0) {
                d = o.optString("cwd", "");
            }
            return d.length() == 0 ? null : d;
        } catch (NativeBridge.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw transport(e);
        } catch (Exception e) {
            return null;
        }
    }

    /** "METHOD /path" entries from the server's own OpenAPI document, or null if it cannot be read. */
    Set<String> spec() {
        try {
            Raw r = raw("GET", "/doc", null, CONNECT_MS, 10000, true);
            if (r.status != 200) {
                return null;
            }
            JSONObject paths = new JSONObject(r.body).optJSONObject("paths");
            if (paths == null) {
                return null;
            }
            Set<String> out = new HashSet<String>();
            java.util.Iterator<String> it = paths.keys();
            while (it.hasNext()) {
                String p = it.next();
                JSONObject ops = paths.optJSONObject(p);
                if (ops == null) {
                    continue;
                }
                java.util.Iterator<String> mi = ops.keys();
                while (mi.hasNext()) {
                    out.add(mi.next().toUpperCase(java.util.Locale.US) + " " + p);
                }
            }
            return out.isEmpty() ? null : out;
        } catch (Exception e) {
            return null;
        }
    }

    /** Does an UNAUTHENTICATED request to a protected route succeed? true=auth NOT enforced, false=enforced, null=unknown. */
    Boolean acceptsAnonymous() {
        try {
            Raw r = raw("GET", "/session", null, CONNECT_MS, 8000, false);
            if (r.status == 401 || r.status == 403) {
                return Boolean.FALSE;
            }
            if (r.status == 200) {
                return Boolean.TRUE;
            }
            return null;
        } catch (IOException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- sessions
    String createSession() throws NativeBridge.BridgeException {
        JSONObject o = json("POST", "/session", new JSONObject(), 15000);
        String id = o.optString("id", "");
        if (!ID_RE.matcher(id).matches()) {
            throw new NativeBridge.BridgeException("OPENCODE_BAD_RESPONSE", "OpenCode did not return a session id.", snippet(o.toString()));
        }
        return id;
    }

    JSONArray listSessions() throws NativeBridge.BridgeException {
        return array("GET", "/session", 15000);
    }

    JSONArray messages(String sessionId) throws NativeBridge.BridgeException {
        return array("GET", "/session/" + id(sessionId) + "/message", 30000);
    }

    void deleteSession(String sessionId) throws NativeBridge.BridgeException {
        try {
            check(raw("DELETE", "/session/" + id(sessionId), null, CONNECT_MS, 15000, true), "DELETE /session");
        } catch (IOException e) {
            throw transport(e);
        }
    }

    void abort(String sessionId) throws NativeBridge.BridgeException {
        try {
            check(raw("POST", "/session/" + id(sessionId) + "/abort", "{}", CONNECT_MS, 15000, true), "POST /session/abort");
        } catch (IOException e) {
            throw transport(e);
        }
    }

    /**
     * Sends one user message and BLOCKS until the agent has finished its multi-step run (this is the route the owner
     * verified). No read timeout: see class comment. providerId/modelId may be null = let OpenCode use its own
     * configured model/agent.
     */
    JSONObject sendMessage(String sessionId, String text, String providerId, String modelId, String agent) throws NativeBridge.BridgeException {
        JSONObject body = new JSONObject();
        try {
            JSONArray parts = new JSONArray();
            parts.put(new JSONObject().put("type", "text").put("text", text));
            body.put("parts", parts);
            if (providerId != null && modelId != null) {
                body.put("model", new JSONObject().put("providerID", providerId).put("modelID", modelId));
            }
            if (agent != null && agent.length() > 0) {
                body.put("agent", agent);
            }
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("INTERNAL", "Could not build the message.", null);
        }
        HttpURLConnection c = null;
        try {
            c = open("POST", "/session/" + id(sessionId) + "/message", body.toString(), CONNECT_MS, 360000, true);
            inflightSend = c;
            Raw r = finish(c);
            check(r, "POST /session/message");
            return r.body.trim().length() == 0 ? new JSONObject() : new JSONObject(r.body);
        } catch (NativeBridge.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw transport(e);
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("OPENCODE_BAD_RESPONSE", "OpenCode sent an unreadable answer.", e.getClass().getSimpleName());
        } finally {
            inflightSend = null;
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /** Drops the client side of a running sendMessage (used when the app shuts down). The server keeps working. */
    void dropInflight() {
        HttpURLConnection c = inflightSend;
        if (c != null) {
            c.disconnect();
        }
    }

    // ------------------------------------------------------- models and agents
    JSONObject providers() throws NativeBridge.BridgeException {
        return json("GET", "/config/providers", null, 20000);
    }

    JSONArray agents() throws NativeBridge.BridgeException {
        return array("GET", "/agent", 15000);
    }

    // -------------------------------------------------------------- plumbing
    private static String id(String s) throws NativeBridge.BridgeException {
        if (s == null || !ID_RE.matcher(s).matches()) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "Invalid session id.", null);
        }
        return s;
    }

    private JSONObject json(String method, String path, JSONObject body, int readMs) throws NativeBridge.BridgeException {
        try {
            Raw r = raw(method, path, body == null ? null : body.toString(), CONNECT_MS, readMs, true);
            check(r, method + " " + path);
            return r.body.trim().length() == 0 ? new JSONObject() : new JSONObject(r.body);
        } catch (NativeBridge.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw transport(e);
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("OPENCODE_BAD_RESPONSE", "OpenCode sent an unreadable answer.", method + " " + path);
        }
    }

    private JSONArray array(String method, String path, int readMs) throws NativeBridge.BridgeException {
        try {
            Raw r = raw(method, path, null, CONNECT_MS, readMs, true);
            check(r, method + " " + path);
            return new JSONArray(r.body);
        } catch (NativeBridge.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw transport(e);
        } catch (Exception e) {
            throw new NativeBridge.BridgeException("OPENCODE_BAD_RESPONSE", "OpenCode sent an unreadable answer.", method + " " + path);
        }
    }

    /** Maps HTTP failures to stable codes. The server's own error text is passed through (it is the real provider/agent error). */
    static void check(Raw r, String what) throws NativeBridge.BridgeException {
        if (r.status >= 200 && r.status < 300) {
            return;
        }
        String msg = errorText(r.body);
        if (r.status == 401 || r.status == 403) {
            throw new NativeBridge.BridgeException("OPENCODE_AUTH_FAILED", "OpenCode rejected the credentials.", what + ": HTTP " + r.status);
        }
        if (r.status == 404 || r.status == 405) {
            throw new NativeBridge.BridgeException("OPENCODE_UNSUPPORTED", "This OpenCode server does not offer that operation (" + what + ").", "HTTP " + r.status + (msg.length() > 0 ? ": " + msg : ""));
        }
        if (r.status >= 400 && r.status < 500) {
            throw new NativeBridge.BridgeException("OPENCODE_REJECTED", msg.length() > 0 ? msg : "OpenCode rejected the request (HTTP " + r.status + ").", what + ": HTTP " + r.status);
        }
        throw new NativeBridge.BridgeException("OPENCODE_SERVER_ERROR", msg.length() > 0 ? msg : "OpenCode reported an internal error (HTTP " + r.status + ").", what + ": HTTP " + r.status);
    }

    /** Best-effort extraction of a human message from an error body, else a short raw snippet. */
    static String errorText(String body) {
        if (body == null || body.trim().length() == 0) {
            return "";
        }
        try {
            JSONObject o = new JSONObject(body);
            Object errField = o.opt("error");
            String m = firstNonEmpty(o.optString("message", ""), errField instanceof String ? (String) errField : "");
            JSONObject data = o.optJSONObject("data");
            if (m.length() == 0 && data != null) {
                m = data.optString("message", "");
            }
            JSONObject err = o.optJSONObject("error");
            if (m.length() == 0 && err != null) {
                JSONObject ed = err.optJSONObject("data");
                m = firstNonEmpty(err.optString("message", ""), ed == null ? "" : ed.optString("message", ""), err.optString("name", ""));
            }
            if (m.length() > 0) {
                return clip(m, 600);
            }
        } catch (Exception ignored) {
        }
        return snippet(body);
    }

    private static String firstNonEmpty(String... v) {
        for (String s : v) {
            if (s != null && s.length() > 0) {
                return s;
            }
        }
        return "";
    }

    static String snippet(String s) {
        return clip(s == null ? "" : s.replaceAll("\\s+", " ").trim(), 200);
    }

    private static String clip(String s, int n) {
        return s.length() > n ? s.substring(0, n) + "..." : s;
    }

    private static NativeBridge.BridgeException transport(IOException e) {
        if (e instanceof ConnectException) {
            return new NativeBridge.BridgeException("OPENCODE_UNREACHABLE", "The OpenCode server is not reachable.", "connection refused");
        }
        if (e instanceof SocketTimeoutException) {
            return new NativeBridge.BridgeException("OPENCODE_TIMEOUT", "OpenCode did not answer in time.", null);
        }
        return new NativeBridge.BridgeException("OPENCODE_CONNECTION_LOST", "The connection to OpenCode was lost.", e.getClass().getSimpleName());
    }

    private Raw raw(String method, String path, String body, int connectMs, int readMs, boolean withAuth) throws IOException {
        HttpURLConnection c = null;
        try {
            c = open(method, path, body, connectMs, readMs, withAuth);
            return finish(c);
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    private HttpURLConnection open(String method, String path, String body, int connectMs, int readMs, boolean withAuth) throws IOException {
        URL url = new URL("http", HOST, port, path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);      // never through a proxy
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);                                                          // 0 = wait for the agent run
        c.setRequestMethod(method);
        c.setRequestProperty("Accept", "application/json");
        if (withAuth && authHeader != null) {
            c.setRequestProperty("Authorization", authHeader);
        }
        if (body != null) {
            byte[] bytes = body.getBytes(UTF8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            OutputStream os = c.getOutputStream();
            try {
                os.write(bytes);
            } finally {
                os.close();
            }
        }
        return c;
    }

    private static Raw finish(HttpURLConnection c) throws IOException {
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        return new Raw(status, in == null ? "" : readAll(in));
    }

    private static String readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > MAX_RESPONSE) {
                    throw new IOException("response too large");
                }
            }
            return new String(bos.toByteArray(), UTF8);
        } finally {
            in.close();
        }
    }

    /** Own Base64 (java.util.Base64 needs API 26, this app supports API 23; android.util.Base64 is not available to plain-Java tests). */
    static String base64(byte[] in) {
        final String a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < in.length; i += 3) {
            int b0 = in[i] & 0xff, b1 = i + 1 < in.length ? in[i + 1] & 0xff : 0, b2 = i + 2 < in.length ? in[i + 2] & 0xff : 0;
            sb.append(a.charAt(b0 >> 2)).append(a.charAt(((b0 & 3) << 4) | (b1 >> 4)));
            sb.append(i + 1 < in.length ? a.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=');
            sb.append(i + 2 < in.length ? a.charAt(b2 & 63) : '=');
        }
        return sb.toString();
    }
}
