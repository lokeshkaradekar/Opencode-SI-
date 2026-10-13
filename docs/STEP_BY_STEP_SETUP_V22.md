# OpenCode SI — step-by-step first-run setup (v23)

This build adds a native-bridge setup installer and a live setup wizard.

## User flow
1. Install Termux from the F-Droid page opened by the app and launch it once.
2. Grant OpenCode SI `com.termux.permission.RUN_COMMAND`.
3. If the actual probe reports external commands disabled, copy the command shown by the wizard into Termux, run it, fully close/reopen Termux, then tap **Check again**.
4. Tap **Install / repair components**. The app transfers the compressed daemon bundle from `assets/setup/daemon-bundle.tar.gz` to Termux using the approved RUN_COMMAND bridge, then starts the setup script in the background.
5. The wizard polls actual Termux log/status files and shows installer stages and download progress when available.
6. On successful installer exit, it starts the daemon, starts OpenCode, and requires the real server readiness response before showing **Setup complete**.

## What gets installed
The Termux setup script installs Python, Bash, Git, Node.js, npm, curl and tar. If `opencode` is absent, it downloads the pinned `wallentx/opencode-termux` v1.18.33 Android/Termux ARM64 release, validates the tar archive layout, executes `opencode --version`, and only then atomically installs the binary. It also installs the OpenCode SI daemon scripts and Plan agent config if no user Plan agent already exists.

## Honest failure behavior
- A missing Termux app, missing Android permission, disabled `allow-external-apps`, failed package update, failed download, bad archive, incompatible executable, or server startup failure is reported as a separate step with the actual error/installer tail where available.
- Setup completion is not inferred from a timer. The wizard reads the Termux exit-code file and then verifies the daemon and OpenCode server.
- The installer does not delete project directories. Existing OpenCode installations are retained if `opencode` already runs; this installer only downloads the pinned binary when it is missing.

## Build notes
Copy all of `app/` into Sketchware assets, including `setup/daemon-bundle.tar.gz`. Import updated `app/java/NativeBridge.java` and `app/java/TermuxBackend.java`. Keep `daemon/termux-setup.sh` synchronized with the bundled `app/setup/daemon-bundle.tar.gz` whenever daemon sources change.

## Device test still required
The app must be tested on a real Android device with Termux installed. In particular, confirm RUN_COMMAND permission flow, `allow-external-apps`, background process survival, download URL availability, and actual server readiness.


## v26 path-safety update

Custom-location creation now performs a daemon capability preflight before POSTing a project. If an old daemon does not advertise `customProjectParents`, the app stops and asks for Setup; it does not send a create request that an older daemon could silently ignore. The daemon advertises `/v1/projects/capabilities` and supports `require_parent`. Setup stops the old daemon before package updates, replaces daemon files, and removes stale daemon metadata. Custom-path behavior still needs validation on the target Android device.
