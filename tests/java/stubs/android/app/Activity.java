package android.app;
import android.os.Bundle;
public class Activity extends android.content.Context { protected void onCreate(Bundle b){} protected void onPause(){} protected void onResume(){} protected void onDestroy(){}
 public void onBackPressed(){} public void setContentView(android.view.View v){} public void runOnUiThread(Runnable r){}
 public android.content.pm.ApplicationInfo getApplicationInfo(){return null;} public void requestPermissions(String[] p,int c){}
 public void onRequestPermissionsResult(int c,String[] p,int[] g){} public void startActivityForResult(android.content.Intent i,int rc){}
 protected void onActivityResult(int rc,int res,android.content.Intent d){} public static final int RESULT_OK=-1; }
