# Installation and first run

> **Status:** these steps document the source-to-APK path. A successful Sketchware build and end-to-end install have not been verified by the automated Linux test environment. This repository currently has no Gradle wrapper or prebuilt, certified APK.

## 1. Prerequisites

- Android device; ARM64 is required for the documented OpenCode Termux binary.
- Sketchware Pro (supports custom Java import).
- Termux from F-Droid or the official Termux GitHub releases.
- Network access for Termux package downloads and any remote model provider.
- A copy of this repository on your device or development computer.

## 2. Import the app into Sketchware Pro

1. Create or open a Sketchware Pro project.
2. Set the app name to `OpenCode SI` and package name to `com.opencode.mobile`.
3. Import the Java sources under `app/java/` using Java Manager/custom Java. Preserve the `com.opencode.mobile` package declarations. See `docs/SKETCHWARE_SETUP.md` for the class list and activity setup.
4. Copy the contents of `app/` to the Sketchware assets directory, preserving `index.html`, `css/`, `js/`, and `setup/` folder structure. Do not package development-only `app/dev/` or `app/dev.html` in the production APK.
5. Configure manifest permissions, package visibility, activity attributes, and loopback cleartext networking as described in `docs/SKETCHWARE_SETUP.md`.
6. Build from Sketchware Pro. Resolve version-specific import or manifest errors before installing.

## 3. Install and prepare Termux

1. Install Termux from F-Droid or official GitHub releases and open it once.
2. Open OpenCode SI and follow its setup page. Let the app install or repair required dependencies when automatic setup is available.
3. If you need to update packages manually, run in Termux:

   ```bash
   pkg update && pkg upgrade -y
   ```

4. Grant shared-storage access when your workspace is under Android shared storage:

   ```bash
   termux-setup-storage
   ```

5. If Android blocks access, open **Settings → Apps → Termux → Permissions** and grant the available file/storage permission. Force-stop Termux from app settings, then reopen it.
6. Check and create the default shared-storage workspace if needed:

   ```bash
   ls -ld ~/storage/shared
   ls -ld ~/storage/shared/Download
   mkdir -p ~/storage/shared/Download/opencode-si
   ls -ld ~/storage/shared/Download/opencode-si
   ```

7. If Termux refuses external app commands, follow the app's **Manual / another way** instructions to set `allow-external-apps = true` in `~/.termux/termux.properties`, then fully restart Termux. Avoid appending duplicate lines; check the existing file first.

## 4. Verify setup

1. Return to OpenCode SI and tap **Check again** or **Retry setup**.
2. Review every check, not only the overall status. Resolve any permission, storage, binary, version, or server issue reported in diagnostics.
3. Treat setup as complete only when the app's required live checks pass.
4. If the OpenCode server does not start, open **Technical details and installer log** and save a sanitized copy for troubleshooting.

## 5. Configure the AI agent

Open the OpenCode agent settings and configure the model/provider through the installed OpenCode configuration. Provider requirements, model availability, and costs depend on the provider you choose. Never paste a private API key into a public issue or screenshot.

## 6. Smoke test

Before using an important project, verify on a disposable test project that health checks pass, the agent server is reachable, a harmless terminal command runs, a test file can be created and read back, Git status reflects a test change, and snapshot/undo behaviour is understood.

## Troubleshooting

Use app diagnostics first. Then consult `docs/OPENCODE.md`, `docs/STATUS.md`, and `docs/REPAIR_NOTES.md`. Include device model, Android version, CPU architecture, Termux version, source revision, exact error text, and sanitized logs when asking for help.
