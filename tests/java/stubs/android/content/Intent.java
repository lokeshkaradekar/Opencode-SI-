package android.content;
public class Intent { public static final String ACTION_OPEN_DOCUMENT_TREE="android.intent.action.OPEN_DOCUMENT_TREE", ACTION_VIEW="android.intent.action.VIEW", ACTION_SENDTO="android.intent.action.SENDTO"; public static final int FLAG_ACTIVITY_NEW_TASK=268435456, FLAG_GRANT_READ_URI_PERMISSION=1;
 public Intent(String a){} public Intent setClassName(String p,String c){return this;} public Intent setPackage(String p){return this;}
 public Intent putExtra(String k,String v){return this;} public Intent putExtra(String k,String[] v){return this;} public Intent putExtra(String k,boolean v){return this;}
 public Intent putExtra(String k,android.os.Parcelable v){return this;} public Intent addFlags(int f){return this;} public Intent setData(android.net.Uri u){return this;}
 public android.os.Bundle getBundleExtra(String k){return null;} public android.net.Uri getData(){return null;} }
