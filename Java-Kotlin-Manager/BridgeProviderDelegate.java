package com.opencode.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Provider configuration, secret-presence, and provider-probe operations delegated by NativeBridge. */
final class BridgeProviderDelegate {
    private static final Set<String> PROVIDERS = new HashSet<String>(Arrays.asList("hosted", "compatible", "local"));
    private final Activity activity;
    private final TermuxBackend termux;
    private final SecureStore secrets;

    BridgeProviderDelegate(Activity activity, TermuxBackend termux, SecureStore secrets) {
        this.activity = activity;
        this.termux = termux;
        this.secrets = secrets;
    }

    private SharedPreferences prefs() {
        return activity.getSharedPreferences("opencode_si_providers", Context.MODE_PRIVATE);
    }

    private static String defaultBase(String id) {
        if ("hosted".equals(id)) return "https://openrouter.ai/api/v1";
        if ("local".equals(id)) return "http://127.0.0.1:11434/v1";
        return "";
    }

    private static void validateProvider(String id) throws NativeBridge.BridgeException {
        if (!PROVIDERS.contains(id)) throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "Unknown provider.", null);
    }

    private static String secretId(String id) throws NativeBridge.BridgeException {
        validateProvider(id);
        return "provider." + id;
    }

    JSONObject providerConfig(String id) throws Exception {
        validateProvider(id);
        SharedPreferences p = prefs();
        return new JSONObject().put("id", id).put("baseUrl", p.getString(id + ".base_url", defaultBase(id)))
                .put("model", p.getString(id + ".model", "")).put("needsKey", !"local".equals(id))
                .put("hasKey", secrets.has(secretId(id)));
    }

    JSONObject setProviderConfig(JSONObject a) throws Exception {
        String id = a.optString("id", "");
        validateProvider(id);
        String base = a.optString("baseUrl", "").trim();
        String model = a.optString("model", "").trim();
        if (base.length() > 0 && !(base.startsWith("https://") || base.startsWith("http://"))) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "The URL must start with https:// (or http:// for a server on this device or LAN).", null);
        }
        if (base.length() > 300 || model.length() > 200) {
            throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "The URL or model name is too long.", null);
        }
        if (base.length() > 0) {
            try {
                URI u = new URI(base);
                if (u.getHost() == null || u.getUserInfo() != null) {
                    throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "Enter a URL like https://host/v1 (credentials in the URL are not allowed).", null);
                }
            } catch (URISyntaxException e) {
                throw new NativeBridge.BridgeException("INVALID_ARGUMENT", "That is not a valid URL.", null);
            }
        }
        prefs().edit().putString(id + ".base_url", base).putString(id + ".model", model).commit();
        return providerConfig(id);
    }

    /** The API key is read only here and sent only to the local authenticated daemon. */
    JSONObject providerForDaemon(String id) throws Exception {
        validateProvider(id);
        SharedPreferences p = prefs();
        JSONObject o = new JSONObject().put("base_url", p.getString(id + ".base_url", defaultBase(id)))
                .put("model", p.getString(id + ".model", "")).put("needs_key", !"local".equals(id));
        String key = secrets.get(secretId(id));
        if (key != null) o.put("api_key", key);
        return o;
    }

    JSONObject providerHealth(String id) throws Exception {
        validateProvider(id);
        try {
            termux.ensureDaemon(true);
        } catch (NativeBridge.BridgeException e) {
            return new JSONObject().put("status", "failed").put("detail", "Cannot check: the Termux daemon is not reachable").put("raw", e.code);
        }
        return TermuxBackend.data(termux.postSlow("/v1/agent/probe", new JSONObject().put("provider", providerForDaemon(id)), 40000));
    }

    JSONArray listModels(String id) throws Exception {
        validateProvider(id);
        termux.ensureDaemon(true);
        return TermuxBackend.dataArray(termux.postSlow("/v1/agent/models", new JSONObject().put("provider", providerForDaemon(id)), 40000));
    }
}
