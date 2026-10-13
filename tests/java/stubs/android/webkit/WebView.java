package android.webkit;
public class WebView extends android.view.View { public WebView(android.content.Context c){} public static void setWebContentsDebuggingEnabled(boolean b){}
 public WebSettings getSettings(){return null;} public void setWebViewClient(WebViewClient c){} public void addJavascriptInterface(Object o,String n){} public void removeJavascriptInterface(String n){}
 public void loadUrl(String u){} public void loadData(String d,String m,String e){} public void evaluateJavascript(String s,ValueCallback<String> cb){} public void destroy(){} }
