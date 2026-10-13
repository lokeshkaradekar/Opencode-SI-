# Branded startup splash v19

- Adds the user's supplied `opencode-splash.jpg` unchanged at the Android assets root.
- `MainActivity` places a native black `ImageView` overlay over the WebView while the local app UI initializes. The image is fit-centered without cropping or editing.
- The overlay fades in and out; the image pixels are not animated or modified.
- The overlay is dismissed after `window.__OPENCODE_SI_UI_READY` becomes true and a minimum display interval has elapsed.
- A fail-safe hides the overlay after 8.5 seconds so a broken UI does not trap the user.
- If resume recovery detects an unready WebView, it displays the same splash while reloading the local UI.
- No server/Termux startup is awaited by the splash; server initialization can continue behind the UI.

## Device checklist
1. Copy all `app/` assets (except `app/java/`, `app/dev/`, and `app/dev.html`) into Sketchware's assets directory, including `opencode-splash.jpg` at its root.
2. Apply updated Java sources in `app/java/`.
3. Cold-launch: logo should appear immediately, then fade to the app after UI render.
4. Background the app and return; if WebView needs recovery, logo should appear during reload.
5. Temporarily remove the splash asset only in a test copy; app should still load without crashing.

This source change has not been tested on a physical Android device.
