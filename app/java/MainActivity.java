package com.opencode.mobile;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;

/**
 * Hosts the WebView UI (assets/index.html) and the single JavaScript bridge.
 *
 * Manifest requirements (see docs/SKETCHWARE_SETUP.md):
 *   android:windowSoftInputMode="adjustResize"
 *   android:configChanges="orientation|screenSize|keyboardHidden|uiMode|screenLayout|smallestScreenSize"
 *   uses-permission com.termux.permission.RUN_COMMAND, queries package com.termux (Android 11+),
 *   cleartext HTTP to 127.0.0.1 only (usesCleartextTraffic or network security config)
 *
 * Only AndroidBridge (NativeBridge.request) is exposed; no other Java object, no arbitrary reflection surface.
 */
public class MainActivity extends Activity {
    static final int REQ_TERMUX = 4101;
    static final int REQ_FOLDER = 4102;
    static final int REQ_PROJECT_FOLDER = 4103;
    private static final String ASSET_INDEX = "file:///android_asset/index.html";
    private static final String ASSET_PREFIX = "file:///android_asset/";

    private WebView web;
    private NativeBridge bridge;
    private FrameLayout root;
    private ImageView splashOverlay;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private long splashShownAt = 0L;
    private boolean splashHideStarted = false;
    private boolean pageLoaded = false;
    private boolean resumeRecoveryScheduled = false;
    private int webGeneration = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildWebView();
    }

    private void buildWebView() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(debuggable);       // never in release builds
        }
        pageLoaded = false;
        final int generation = ++webGeneration;
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        // Keep a dark native canvas behind the WebView while local assets and JavaScript start.
        web.setBackgroundColor(Color.rgb(10, 10, 10));
        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);
        showSplashOverlay(generation);
        // Fail-safe: never trap the user behind the splash if the WebView cannot initialize.
        root.postDelayed(new Runnable() { @Override public void run() { hideSplashOverlay(generation); } }, 10000L);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);                     // required: the UI is JavaScript
        s.setDomStorageEnabled(true);                     // localStorage for UI preferences only; secrets never go there
        s.setAllowFileAccess(false);                      // does not affect file:///android_asset
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSaveFormData(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (v == web && generation == webGeneration) {
                    pageLoaded = true;
                    watchForUiReady(generation);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !r.getUrl().toString().startsWith(ASSET_PREFIX);      // block every navigation away from the app
            }

            // The app never needs the network from the page. Anything that is not a local asset / data / blob is refused,
            // so injected markup cannot beacon data out or load remote script next to the bridge.
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (u.startsWith("file:///android_asset/") || u.startsWith("data:") || u.startsWith("blob:")) {
                    return null;
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, android.webkit.WebResourceError e) {
                if (r.isForMainFrame()) {
                    v.loadData("<html><body style='margin:0;background:#0a0a0a;color:#f5f0e7;font-family:sans-serif;padding:24px'><h3>OpenCode SI could not load</h3>"
                            + "<p>Some local app assets are missing or damaged. Reinstall the app and its assets.</p></body></html>", "text/html", "UTF-8");
                    mainHandler.postDelayed(new Runnable() { @Override public void run() { hideSplashOverlay(generation); } }, 350L);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                // The WebView renderer crashed or was killed by Android: rebuild instead of crashing the app.
                runOnUiThread(new Runnable() {
                    public void run() {
                        teardown();
                        buildWebView();
                    }
                });
                return true;
            }
        });

        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        web.loadUrl(ASSET_INDEX);
    }

    /** Displays the supplied logo unchanged while the local WebView interface initializes. */
    private void showSplashOverlay(final int generation) {
        if (root == null || generation != webGeneration || splashOverlay != null) return;
        ImageView image = new ImageView(this);
        image.setBackgroundColor(Color.BLACK);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        try {
            InputStream input = getAssets().open("opencode-splash.jpg");
            Bitmap bitmap;
            try { bitmap = BitmapFactory.decodeStream(input); } finally { input.close(); }
            if (bitmap != null) image.setImageBitmap(bitmap);
        } catch (Exception ignored) {
            // If the image asset was not copied, retain a dark startup canvas and let the app load.
            return;
        }
        image.setContentDescription("OpenCode — The open source AI coding agent");
        image.setAlpha(0f);
        root.addView(image, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        image.bringToFront();
        splashOverlay = image;
        splashShownAt = System.currentTimeMillis();
        splashHideStarted = false;
        image.animate().alpha(1f).setDuration(220L).start();
        // A fresh fail-safe is scheduled each time the splash is shown, including resume recovery.
        root.postDelayed(new Runnable() { @Override public void run() { hideSplashOverlay(generation); } }, 8500L);
    }

    /** Waits for the first successful local UI render, but never blocks longer than the fail-safe. */
    private void watchForUiReady(final int generation) {
        if (generation != webGeneration || web == null || splashOverlay == null) return;
        final WebView watchedWeb = web;
        watchedWeb.evaluateJavascript("window.__OPENCODE_SI_UI_READY === true", new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) {
                if (generation != webGeneration || watchedWeb != web || splashOverlay == null) return;
                long elapsed = System.currentTimeMillis() - splashShownAt;
                if ("true".equals(value) && elapsed >= 850L) {
                    hideSplashOverlay(generation);
                } else {
                    mainHandler.postDelayed(new Runnable() {
                        @Override public void run() { watchForUiReady(generation); }
                    }, elapsed < 850L ? Math.min(150L, 850L - elapsed) : 180L);
                }
            }
        });
    }

    private void hideSplashOverlay(final int generation) {
        if (generation != webGeneration || splashOverlay == null || splashHideStarted) return;
        splashHideStarted = true;
        final ImageView image = splashOverlay;
        final FrameLayout parent = root;
        image.animate().alpha(0f).setDuration(240L).withEndAction(new Runnable() {
            @Override public void run() {
                if (generation == webGeneration && parent == root && image == splashOverlay) {
                    parent.removeView(image);
                    splashOverlay = null;
                }
            }
        }).start();
    }

    private void teardown() {
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
            web.destroy();
            web = null;
        }
        splashOverlay = null;
        root = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_TERMUX && bridge != null) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            bridge.onPermissionResult(ok);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (bridge != null && resultCode == RESULT_OK && data != null) {
            if (requestCode == REQ_FOLDER) bridge.onFolderPicked(data.getData());
            else if (requestCode == REQ_PROJECT_FOLDER) bridge.onProjectFolderPicked(data.getData());
        }
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // Let the UI consume "back" (close sheet, leave editor, change tab...) before leaving the app.
        web.evaluateJavascript("(window.onAndroidBack && window.onAndroidBack()) === true", new ValueCallback<String>() {
            public void onReceiveValue(String value) {
                if (!"true".equals(value)) {
                    MainActivity.super.onBackPressed();
                }
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.evaluateJavascript("window.onAndroidLifecycle && window.onAndroidLifecycle('pause')", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) {
            bridge.onActivityResumed();                  // non-blocking server re-check (never starts a second server)
        }
        if (web != null) {
            final WebView resumedWeb = web;
            final int generation = webGeneration;
            resumedWeb.evaluateJavascript("window.onAndroidLifecycle && window.onAndroidLifecycle('resume')", null);
            // Android may keep the Activity but discard/suspend the WebView renderer. If the
            // page returns without its JS app having completed a render, recover it automatically.
            // Delay checks so a normal slow resume/bridge response is not mistaken for a dead page.
            if (pageLoaded && !resumeRecoveryScheduled) {
                resumeRecoveryScheduled = true;
                resumedWeb.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (web != resumedWeb || generation != webGeneration) { resumeRecoveryScheduled = false; return; }
                        resumedWeb.evaluateJavascript(
                            "(function(){var a=document.getElementById('app'),s=document.getElementById('screen');return !!(window.__OPENCODE_SI_UI_READY===true&&a&&s&&document.documentElement&&document.body);})()",
                            new ValueCallback<String>() {
                                @Override public void onReceiveValue(String value) {
                                    if (web != resumedWeb || generation != webGeneration) { resumeRecoveryScheduled = false; return; }
                                    if (!"true".equals(value)) {
                                        // Put the branded startup screen over a blank/stale WebView while recovery runs.
                                        showSplashOverlay(generation);
                                        // One grace period avoids reloads while the UI is still restoring.
                                        resumedWeb.postDelayed(new Runnable() {
                                            @Override public void run() {
                                                if (web == resumedWeb && generation == webGeneration) {
                                                    resumedWeb.evaluateJavascript("window.__OPENCODE_SI_UI_READY===true", new ValueCallback<String>() {
                                                        @Override public void onReceiveValue(String retry) {
                                                            if (web == resumedWeb && generation == webGeneration && !"true".equals(retry)) {
                                                                pageLoaded = false;
                                                                resumedWeb.loadUrl(ASSET_INDEX);
                                                            }
                                                            resumeRecoveryScheduled = false;
                                                        }
                                                    });
                                                } else resumeRecoveryScheduled = false;
                                            }
                                        }, 900);
                                    } else resumeRecoveryScheduled = false;
                                }
                            });
                    }
                }, 1200);
            }
        }
    }

    @Override
    protected void onDestroy() {
        teardown();
        super.onDestroy();
    }
}
