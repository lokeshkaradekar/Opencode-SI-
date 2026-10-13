package android.webkit;
public abstract class WebSettings { public static final int MIXED_CONTENT_NEVER_ALLOW=1,LOAD_NO_CACHE=2; public void setJavaScriptEnabled(boolean b){} public void setDomStorageEnabled(boolean b){}
 public void setAllowFileAccess(boolean b){} public void setAllowContentAccess(boolean b){} public void setAllowFileAccessFromFileURLs(boolean b){} public void setAllowUniversalAccessFromFileURLs(boolean b){}
 public void setMixedContentMode(int m){} public void setGeolocationEnabled(boolean b){} public void setSupportMultipleWindows(boolean b){} public void setJavaScriptCanOpenWindowsAutomatically(boolean b){}
 public void setSupportZoom(boolean b){} public void setBuiltInZoomControls(boolean b){} public void setDisplayZoomControls(boolean b){} public void setSaveFormData(boolean b){} public void setCacheMode(int m){} }
