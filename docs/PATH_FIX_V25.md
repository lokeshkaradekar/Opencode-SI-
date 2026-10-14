# OpenCode SI v25 — daemon path fix

This update addresses the stale daemon process that can keep serving old project-creation behavior after new Python files are copied.

## Apply it
1. Import this source into Sketchware Pro and copy the complete `app/` asset tree (including `setup/daemon-bundle.tar.gz`).
2. Rebuild and install the APK.
3. Open the app's Setup screen and run setup to completion.
4. Wait for the app to restart/check OpenCode and show Ready.
5. Test creating a project in a folder you select. Verify the displayed actual path before relying on it.

## What changed
- Setup reads the daemon PID from `~/.opencode-si/daemon.json`.
- It correctly decodes `/proc/<pid>/cmdline` using a NUL separator, verifies that the process is this app's daemon, and stops it before replacing daemon files.
- It waits for termination and only force-stops the same matching daemon if necessary.
- It replaces the daemon source files, removes stale `daemon.json`, and runs `py_compile` before setup reports success.
- The new daemon already supports the API `parent` field for custom project locations; this ensures the updated code can actually be loaded by a fresh daemon process.

## Verification limits
Shell syntax, JavaScript syntax, asset checks and frontend tests pass in this build environment. No Android APK or physical-device run was performed here.
