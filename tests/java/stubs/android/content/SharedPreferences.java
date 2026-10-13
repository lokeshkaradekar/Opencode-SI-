package android.content;
public interface SharedPreferences { String getString(String k,String d); int getInt(String k,int d); boolean contains(String k); Editor edit();
 interface Editor { Editor putString(String k,String v); Editor putInt(String k,int v); Editor remove(String k); boolean commit(); } }
