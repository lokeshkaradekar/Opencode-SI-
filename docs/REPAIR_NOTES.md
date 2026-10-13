# OpenCode SI reliability repair notes

This update addresses the reported failures in the actual source project.

## Changes

- Project Rename/Delete first use the daemon's dedicated project routes. If an older already-running daemon answers `NOT_FOUND: No such endpoint`, the native bridge falls back to a bounded Termux script using positional arguments and a fixed `~/OpenCodeProjects` root. Project IDs are validated before the fallback; symlinked roots, path escape, duplicate names, and missing directories are rejected.
- Pinning remains per-device persistent metadata in the UI. Project cards sort pinned projects first, then by last open / last SI task timestamp.
- SI completion recovery now treats an unfinished tool step as evidence that the task is still active. The transport-recovery loop checks full step signatures and allows a bounded 15-minute recovery window instead of declaring uncertainty merely because a long tool call is quiet.
- The Files opener now refuses absolute paths outside the selected project instead of incorrectly converting `/storage/emulated/0/Ringtones/...` into a fake relative path. The project workspace is aligned to `~/OpenCodeProjects/<project>`; the existing OpenCode workspace guard blocks agent operations when a foreign server is running in another directory.
- A real Plan agent can be installed for an app-managed OpenCode server if the server's readable agent list proves `plan` is missing. The generated primary agent denies file edits and asks for shell permission. The app restarts only the server it owns and rechecks the agent list. Existing user `plan.md` files are never overwritten. For a foreign/external server, the app will not kill it; configure the agent and restart that server yourself.

## Install

1. Keep a copy of your current project as a backup.
2. Import/replace the source files from this ZIP in the same Sketchware project, including all `app/java/`, `app/js/`, `daemon/`, and `docs/` files. Do not copy only the HTML/CSS.
3. Rebuild and install the APK.
4. Open the app, open a project, and check **Settings → OpenCode → Workspace**. Choose **Follow open project** for the agent and Files tab to use the same directory.
5. Open Health and press Repair if the OpenCode server is not ready. If a server was started manually outside the app, stop/restart it in Termux when the workspace or Plan-agent configuration changes; OpenCode SI never kills a foreign server.

The older daemon can still be used for project Rename/Delete because the updated native bridge has a compatibility fallback. The updated `daemon/termux-setup.sh` also installs the restricted Plan agent if one is not already present, but it is not necessary to run that script for every app launch.

## Verification scope

Frontend tests and asset checks run in this environment. Java sources compile against the project's Android/org.json stubs, and the plain-Java command-policy and OpenCode lifecycle suites run. This environment cannot build or install the Android APK on the user's phone or verify the user's live Termux/OpenCode server. Device verification is still required for the workspace, permission and server-restart paths.

## Managed server drop recovery (2026-10-11)

The app now schedules a real OpenCode recheck every 25 seconds while the WebView is alive. If a probe confirms that a server previously managed by OpenCode SI has stopped, the app requests one normal (non-forced) recovery attempt. It does not restart a foreign server and skips monitoring while the reported agent task count is non-zero. Returning to the foreground also triggers this check. This addresses server loss during use; it cannot keep Android from force-stopping Termux, and device testing is still required to confirm recovery on the target phone.

## Selected-project workspace guard (v4)

- Before each new SI task and before resuming a task, the frontend sets OpenCode's workspace mode to `project` and requests a real readiness check.
- If the server is not READY, or a non-app-managed server cannot verify its workspace, SI refuses to send the task and shows the actual error instead of silently writing into a stale/custom directory.
- This specifically targets files being created in a folder different from the one shown in the Files tab. It does not automatically import or expose files that were already created outside the selected project.
- Verification: `npm run test:frontend` (53 passed) and `npm run build` (17 assets, 0 problems). Android/Termux runtime remains unverified until tested on device.
