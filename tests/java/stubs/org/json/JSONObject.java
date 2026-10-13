package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** TEST DOUBLE of Android's built-in org.json.JSONObject (small, real parser/serializer). Not shipped in the APK. */
public class JSONObject {
    public static final Object NULL = new Object() {
        public String toString() { return "null"; }
        public boolean equals(Object o) { return o == this || o == null; }
        public int hashCode() { return 0; }
    };
    final Map<String, Object> map = new LinkedHashMap<String, Object>();

    public JSONObject() {}

    public JSONObject(String s) throws JSONException {
        Parser p = new Parser(s);
        Object v = p.value();
        p.end();
        if (!(v instanceof JSONObject)) throw new JSONException("Value is not a JSONObject");
        map.putAll(((JSONObject) v).map);
    }

    public JSONObject put(String k, Object v) throws JSONException { if (v == null) map.remove(k); else map.put(k, v); return this; }
    public JSONObject put(String k, boolean v) throws JSONException { map.put(k, Boolean.valueOf(v)); return this; }
    public JSONObject put(String k, int v) throws JSONException { map.put(k, Integer.valueOf(v)); return this; }
    public JSONObject put(String k, long v) throws JSONException { map.put(k, Long.valueOf(v)); return this; }
    public JSONObject put(String k, double v) throws JSONException { map.put(k, Double.valueOf(v)); return this; }
    public Object get(String k) throws JSONException { if (!map.containsKey(k)) throw new JSONException("No value for " + k); return map.get(k); }
    public Object opt(String k) { return map.get(k); }
    public boolean has(String k) { return map.containsKey(k); }
    public boolean isNull(String k) { Object o = map.get(k); return o == null || o == NULL; }
    public int length() { return map.size(); }
    public Object remove(String k) { return map.remove(k); }
    public Iterator<String> keys() { return new java.util.ArrayList<String>(map.keySet()).iterator(); }

    public String getString(String k) throws JSONException {
        Object o = get(k);
        if (o == NULL) throw new JSONException("null for " + k);
        return o instanceof String ? (String) o : String.valueOf(o);
    }
    public String optString(String k) { return optString(k, ""); }
    public String optString(String k, String d) { Object o = map.get(k); return o == null || o == NULL ? d : (o instanceof String ? (String) o : String.valueOf(o)); }
    public int optInt(String k) { return optInt(k, 0); }
    public int optInt(String k, int d) { return (int) optLong(k, d); }
    public long optLong(String k) { return optLong(k, 0); }
    public long optLong(String k, long d) {
        Object o = map.get(k);
        if (o instanceof Number) return ((Number) o).longValue();
        if (o instanceof String) { try { return Long.parseLong(((String) o).trim()); } catch (NumberFormatException e) { return d; } }
        return d;
    }
    public double optDouble(String k, double d) { Object o = map.get(k); return o instanceof Number ? ((Number) o).doubleValue() : d; }
    public boolean optBoolean(String k) { return optBoolean(k, false); }
    public boolean optBoolean(String k, boolean d) {
        Object o = map.get(k);
        if (o instanceof Boolean) return (Boolean) o;
        if (o instanceof String) { String s = (String) o; if (s.equalsIgnoreCase("true")) return true; if (s.equalsIgnoreCase("false")) return false; }
        return d;
    }
    public JSONObject getJSONObject(String k) throws JSONException { Object o = get(k); if (o instanceof JSONObject) return (JSONObject) o; throw new JSONException(k + " is not a JSONObject"); }
    public JSONObject optJSONObject(String k) { Object o = map.get(k); return o instanceof JSONObject ? (JSONObject) o : null; }
    public JSONArray optJSONArray(String k) { Object o = map.get(k); return o instanceof JSONArray ? (JSONArray) o : null; }

    public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(quote(e.getKey())).append(':').append(write(e.getValue()));
        }
        return sb.append('}').toString();
    }

    static String write(Object v) {
        if (v == null || v == NULL) return "null";
        if (v instanceof String) return quote((String) v);
        if (v instanceof Number || v instanceof Boolean || v instanceof JSONObject || v instanceof JSONArray) return v.toString();
        return quote(String.valueOf(v));
    }

    public static String quote(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '/': sb.append("\\/"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c)); else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** Strict-enough recursive-descent JSON parser. */
    static final class Parser {
        final String s; int i;
        Parser(String s) { this.s = s == null ? "" : s; }
        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        void end() throws JSONException { ws(); if (i != s.length()) throw new JSONException("Trailing data at " + i); }
        Object value() throws JSONException {
            ws();
            if (i >= s.length()) throw new JSONException("Unexpected end");
            char c = s.charAt(i);
            if (c == '{') {
                i++; JSONObject o = new JSONObject(); ws();
                if (i < s.length() && s.charAt(i) == '}') { i++; return o; }
                while (true) {
                    ws(); if (i >= s.length() || s.charAt(i) != '"') throw new JSONException("Expected key at " + i);
                    String k = str(); ws();
                    if (i >= s.length() || s.charAt(i) != ':') throw new JSONException("Expected : at " + i);
                    i++; o.map.put(k, value()); ws();
                    if (i >= s.length()) throw new JSONException("Unterminated object");
                    char d = s.charAt(i++);
                    if (d == '}') return o;
                    if (d != ',') throw new JSONException("Expected , at " + (i - 1));
                }
            }
            if (c == '[') {
                i++; JSONArray a = new JSONArray(); ws();
                if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
                while (true) {
                    a.list.add(value()); ws();
                    if (i >= s.length()) throw new JSONException("Unterminated array");
                    char d = s.charAt(i++);
                    if (d == ']') return a;
                    if (d != ',') throw new JSONException("Expected , at " + (i - 1));
                }
            }
            if (c == '"') return str();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return NULL; }
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (st == i) throw new JSONException("Unexpected character at " + i);
            String n = s.substring(st, i);
            try {
                if (n.indexOf('.') >= 0 || n.indexOf('e') >= 0 || n.indexOf('E') >= 0) return Double.valueOf(n);
                long l = Long.parseLong(n);
                return (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) ? (Object) Integer.valueOf((int) l) : (Object) Long.valueOf(l);
            } catch (NumberFormatException e) { throw new JSONException("Bad number " + n); }
        }
        String str() throws JSONException {
            i++; StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                if (i >= s.length()) break;
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break; case 't': sb.append('\t'); break; case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break; case 'f': sb.append('\f'); break;
                    case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: sb.append(e);
                }
            }
            throw new JSONException("Unterminated string");
        }
    }
}
