# Sketchware setup — OpenCode SI (`com.opencode.mobile`)

> **Honesty note.** The Java was compile-checked against hand-written stubs and its pure logic unit-tested, but it has
> **never been built in Sketchware or run on a phone**. Sketchware menus differ between "Sketchware Pro" versions; the
> steps below name the standard places and say what to do if yours differs. Everything marked
> **UNVERIFIED — ANDROID DEVICE TEST REQUIRED** is exactly that.

You need: Android 8+ (minSdk **23**), **Sketchware Pro** (stock Sketchware cannot import custom Java), **Termux from F-Droid / GitHub**
(not the Play Store build, which is outdated), and this repository on the phone.

## What goes where
| Repo path | Goes to |
|---|---|
| `app/java/MainActivity.java`, `NativeBridge.java`, `TermuxBackend.java`, `SecureStore.java` | Sketchware project → Java files (package `com.opencode.mobile`) |
| everything in `app/` **except** `java/`, `dev/`, `dev.html` | Sketchware project → assets (keep the folder layout: `index.html`, `css/`, `js/`) |
| `daemon/*.py`, `daemon/termux-setup.sh` | Termux (`~/.opencode-si/`), via the setup script |
`dev/` and `dev.html` contain the development-only mock. Do **not** put them in the APK.

## 1. Create / open the Sketchware project
Open Sketchware Pro → **+** (new project).
## 2. Name and package
- App name: `OpenCode SI`
- Package name: `com.opencode.mobile`
- Min SDK: **23** (Keystore AES-GCM needs 23). Target SDK: 33 or whatever your Sketchware offers.
## 3–7. Add the Java files
Sketchware Pro keeps custom Java for project `<id>` in `/storage/emulated/0/.sketchware/data/<id>/files/java/`
(Project → **Java Manager** / "Custom Java" in the project menu; if you cannot find it, look for "Manage Java").
Copy the four files there (or use the manager's *import* button):
`MainActivity.java`, `NativeBridge.java`, `TermuxBackend.java`, `SecureStore.java`. Each starts with `package com.opencode.mobile;` — do not edit it.
The launcher activity must be `com.opencode.mobile.MainActivity`. If Sketchware generated its own `MainActivity`, replace it with this
file (Java Manager lets you override a generated class) or, in the manifest manager, make this class the `MAIN/LAUNCHER` activity.
No Gradle dependency is needed: the code uses only `android.*`, `org.json` and `javax.crypto` from the platform.
## 8. Add the assets
Copy the contents of `app/` (without `java/`, `dev/`, `dev.html`) into
`/storage/emulated/0/.sketchware/data/<id>/files/assets/` (Project → **Asset Manager**). Result: `assets/index.html`, `assets/js/*.js`, `assets/css/*.css`, and `assets/opencode-splash.jpg` at the assets root. Keep the splash image filename unchanged; `MainActivity` loads it from Android assets.
## 9. Permissions and manifest
Project → **Manifest Manager** (or "Permissions" + "Custom manifest"). Required:
```xml
<uses-permission android:name="android.permission.INTERNET"/>              <!-- needed for the loopback socket to the daemon only -->
<uses-permission android:name="com.termux.permission.RUN_COMMAND"/>        <!-- lets the app start the daemon in Termux -->
<queries><package android:name="com.termux"/></queries>                     <!-- Android 11+: lets the app see that Termux is installed -->
```
If your manifest editor cannot add `<queries>`, add `android.permission.QUERY_ALL_PACKAGES` instead (fine for sideloaded APKs).
Activity attributes for `MainActivity`:
```
android:windowSoftInputMode="adjustResize"
android:configChanges="orientation|screenSize|keyboardHidden|uiMode|screenLayout|smallestScreenSize"
android:exported="true"
```
Cleartext HTTP to **127.0.0.1 only** (the daemon speaks plain HTTP on loopback). Preferred: add `res/xml/network_security_config.xml`
```xml
<network-security-config><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config></network-security-config>
```
and `android:networkSecurityConfig="@xml/network_security_config"` on `<application>`. If Sketchware cannot add resources, use
`android:usesCleartextTraffic="true"` on `<application>` (broader, but the app opens no other HTTP connection: the **daemon** talks to model providers).
## 10. WebView configuration
Nothing to do in the Sketchware designer: `MainActivity` builds the WebView in code (JavaScript on, file/content access off, all
non-asset requests blocked, remote debugging only in debuggable builds, only `AndroidBridge` exposed). Do not add a WebView block
in the designer.
## 11. Configure Termux
Install Termux (F-Droid), open it once, then:
```sh
pkg install -y git
git clone <your copy of this repo> ~/opencode-si      # or copy the folder with a file manager into Termux's shared storage
cd ~/opencode-si/daemon && bash termux-setup.sh
```
The script installs python/git/nodejs, copies the daemon to `~/.opencode-si/`, creates `~/OpenCodeProjects/`, and sets
`allow-external-apps = true` in `~/.termux/termux.properties`. **Fully close Termux (Exit from its notification) and reopen it once.**
## 12. Install / start the daemon
Preferred: nothing — the app starts it (step 13). Manual start for debugging:
`python ~/.opencode-si/ocd.py --workspace ~/OpenCodeProjects` (it creates `~/.opencode-si/daemon.token`).
## 13. Connect the app to the daemon
First run: Android asks for the Termux permission (or the app's *Health* screen offers it). Grant it. The app generates a random token,
stores it Keystore-encrypted, and starts the daemon through Termux `RUN_COMMAND`, passing the token on stdin.
If you started the daemon yourself (different token) the app shows `DAEMON_AUTH_FAILED`: either `pkill -f ocd.py` and let the app start it,
or paste `~/.opencode-si/daemon.token` into the app (bridge method `configureDaemon`).
## 14. Build the APK
Sketchware: **Run / Build**. Fix any compile error it shows (most likely a Sketchware-version difference in how custom Java is imported; the files themselves
use plain Java 8 with no lambdas and no AndroidX).
## 15. Install the APK
Accept Sketchware's install prompt (allow installs from unknown sources for Sketchware once).
## 16. Test health
Open **Health**. Expect green: Android bridge, Termux app, Termux access, Termux daemon, Daemon authentication, Shell, **PTY**, Workspace,
Process execution, Git. Node/npm/Python green if installed. A red row names the real cause (e.g. `DAEMON_UNREACHABLE`). The screen must never be green with the daemon stopped (try `pkill -f ocd.py` in Termux with autostart blocked by removing the RUN_COMMAND permission).
## 17. Test terminal
Create a project, open **Terminal**:
```
pwd          -> .../OpenCodeProjects/<project>
mkdir src
cd src
pwd          -> .../<project>/src      (same persistent shell)
node -v
sleep 30     -> press Stop: status "cancelled"
```
## 18. Test filesystem
Files tab: create `hello.js`, edit, save, rename, delete. In Termux, `cat ~/OpenCodeProjects/<project>/hello.js` shows the same bytes.
## 19. Test Git
Terminal: `git init` (or Git tab if shown), edit a file, Git tab → status shows `M`/`?`, commit, log shows it.
Pull/push need a remote and credentials set up in Termux (HTTPS token via `git credential` or SSH key); the app never stores them.
## 20. Test the agent
Settings → provider → base URL + model + API key (OpenRouter default: `https://openrouter.ai/api/v1`; any OpenAI-compatible server works) → Save → *List models*.
AI tab: "create hello.js that prints hi and run it". Check in Termux that `hello.js` exists and that the activity list shows the real `node hello.js` run. Undo restores the project.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `BACKEND_UNAVAILABLE` | Termux not installed (or `<queries>` missing on Android 11+) |
| `PERMISSION_DENIED` on start | grant Termux permission; `allow-external-apps = true`; restart Termux |
| `DAEMON_UNREACHABLE` | daemon not installed (`bash termux-setup.sh`) or killed by battery optimisation: exempt Termux |
| `DAEMON_AUTH_FAILED` | token mismatch, see step 13 |
| Cleartext not permitted | step 9 network config |
| `KEYSTORE_UNAVAILABLE` / `SECRET_UNREADABLE` | device without a working Keystore / screen lock changed: enter the key again |


## Persistent AI-task notification (v20)

Import `TaskNotificationService.java` together with the other `app/java/` sources. Add the following manifest permissions and service declaration in Sketchware's AndroidManifest configuration (the source ZIP includes `docs/archive/TASK_NOTIFICATION_MANIFEST.xml` as a copyable fragment):

- `android.permission.FOREGROUND_SERVICE`
- `android.permission.POST_NOTIFICATIONS` (runtime notification permission on Android 13+)
- Add `android.permission.FOREGROUND_SERVICE_SPECIAL_USE` and declare `android:foregroundServiceType="specialUse"` with the `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property as shown in `docs/archive/TASK_NOTIFICATION_MANIFEST.xml`. Android 14+ special-use declarations require a valid platform/policy justification; verify target-SDK and distribution requirements. Do not label unbounded AI work as `dataSync`.
- Register `com.opencode.mobile.TaskNotificationService` as `android:exported="false"` and `android:stopWithTask="false"`.

The v20 service promotes itself to foreground immediately, performs OpenCode status polling on a worker thread (so a slow server cannot freeze the service/UI), persists the updated project/activity/session in the correct order, ignores stale poll responses from an older session, and reports a stale server connection as “Waiting for OpenCode server update”. The ongoing notification includes project/status/current activity/elapsed time and opens the app when tapped. It is marked non-dismissible by normal swipe while a task is active. Android/system settings can still stop the app or suppress notifications; no app can guarantee execution after Force stop, battery-management termination, reboot, or revoked permissions. Test on the target Android version and OEM battery settings.
