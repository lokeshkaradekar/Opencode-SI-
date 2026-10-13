package android.webkit;
public class WebViewClient { public void onPageFinished(WebView v,String url){} public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return false;}
 public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){return null;} public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){}
 public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){return false;} }
