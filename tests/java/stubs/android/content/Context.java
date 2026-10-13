package android.content;
public class Context { public android.content.res.AssetManager getAssets(){return new android.content.res.AssetManager();} public static final int MODE_PRIVATE=0, RECEIVER_NOT_EXPORTED=4; public static final String CLIPBOARD_SERVICE="clipboard"; public Object getSystemService(String name){return new android.content.ClipboardManager();} public Context getApplicationContext(){return this;}
 public SharedPreferences getSharedPreferences(String n,int m){return null;} public android.content.pm.PackageManager getPackageManager(){return null;}
 public int checkSelfPermission(String p){return 0;} public android.content.ComponentName startForegroundService(Intent i){return null;}
 public android.content.ComponentName startService(Intent i){return null;} public java.io.File getFilesDir(){return null;} public String getPackageName(){return "";}
 public Intent registerReceiver(BroadcastReceiver r, IntentFilter f){return null;} public Intent registerReceiver(BroadcastReceiver r, IntentFilter f, int flags){return null;}
 public void unregisterReceiver(BroadcastReceiver r){} public void startActivity(Intent i){} }
