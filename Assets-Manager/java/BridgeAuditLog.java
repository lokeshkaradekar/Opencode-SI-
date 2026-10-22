package com.opencode.mobile;

import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded, local-only audit log. Never stores command arguments, prompts, credentials, or file contents. */
final class BridgeAuditLog {
    private static final String KEY = "bridge.audit.v1";
    private static final int LIMIT = 200;
    private final SharedPreferences prefs;
    BridgeAuditLog(SharedPreferences prefs) { this.prefs = prefs; }
    synchronized void record(String action, String project, String outcome, String detail) {
        try {
            JSONArray old;
            try { old = new JSONArray(prefs.getString(KEY, "[]")); } catch (Exception bad) { old = new JSONArray(); }
            JSONArray next = new JSONArray();
            next.put(new JSONObject().put("at", System.currentTimeMillis()).put("action", safe(action, 48))
                .put("project", safe(project, 64)).put("outcome", safe(outcome, 24)).put("detail", safe(detail, 120)));
            for (int i = Math.max(0, old.length() - (LIMIT - 1)); i < old.length(); i++) {
                JSONObject row = old.optJSONObject(i); if (row != null) next.put(row);
            }
            prefs.edit().putString(KEY, next.toString()).apply();
        } catch (Exception ignored) { }
    }
    synchronized JSONArray read() {
        try { return new JSONArray(prefs.getString(KEY, "[]")); } catch (Exception e) { return new JSONArray(); }
    }
    private static String safe(String s, int n) {
        if (s == null) return "";
        String clean = s.replaceAll("[\\r\\n\\t]", " ").trim();
        return clean.length() <= n ? clean : clean.substring(0, n);
    }
}
