package org.json;

import java.util.ArrayList;
import java.util.List;

/** TEST DOUBLE of Android's built-in org.json.JSONArray. Not shipped in the APK. */
public class JSONArray {
    final List<Object> list = new ArrayList<Object>();
    public JSONArray() {}
    public JSONArray(String s) throws JSONException {
        JSONObject.Parser p = new JSONObject.Parser(s);
        Object v = p.value(); p.end();
        if (!(v instanceof JSONArray)) throw new JSONException("Value is not a JSONArray");
        list.addAll(((JSONArray) v).list);
    }
    public int length() { return list.size(); }
    public JSONArray put(Object o) { list.add(o == null ? JSONObject.NULL : o); return this; }
    public Object opt(int i) { return i >= 0 && i < list.size() ? list.get(i) : null; }
    public JSONObject getJSONObject(int i) throws JSONException { Object o = opt(i); if (o instanceof JSONObject) return (JSONObject) o; throw new JSONException("Index " + i + " is not a JSONObject"); }
    public JSONObject optJSONObject(int i) { Object o = opt(i); return o instanceof JSONObject ? (JSONObject) o : null; }
    public JSONArray optJSONArray(int i) { Object o = opt(i); return o instanceof JSONArray ? (JSONArray) o : null; }
    public String optString(int i) { Object o = opt(i); return o == null || o == JSONObject.NULL ? "" : String.valueOf(o); }
    public String optString(int i, String d) { Object o = opt(i); return o == null || o == JSONObject.NULL ? d : String.valueOf(o); }
    public String toString() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) { if (i > 0) sb.append(','); sb.append(JSONObject.write(list.get(i))); }
        return sb.append(']').toString();
    }
}
