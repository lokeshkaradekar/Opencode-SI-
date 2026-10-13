# OpenCode SI v27 — custom project location fix

## Two different folder settings

- **Projects → New project → Choose phone folder** chooses the parent directory where the new project folder is created.
- **Settings → OpenCode agent workspace** chooses the directory the OpenCode agent works in. It does not control where a new project is created.

The Settings UI now says this explicitly.

## What changed

1. If the running daemon lacks the strict custom-parent capability endpoint, the app automatically updates the bundled daemon source through Termux.
2. The updater checks Python process identity before stopping an old OpenCode SI daemon, scans for a matching daemon process if its metadata is stale/missing, installs the bundled files, compiles them, removes stale daemon metadata, starts a fresh daemon, and verifies the live capability response.
3. Only after the live daemon confirms strict custom-parent support does the app send the selected parent and `require_parent=true`.
4. The daemon refuses to silently fall back to `~/OpenCodeProjects`. It creates under the validated selected parent or returns an error.
5. If Termux cannot access a selected shared-storage folder, the daemon reports a storage-permission-specific message.

## Required device conditions

For a folder under `/storage/emulated/0/...`, Termux itself must be allowed to access shared storage. If the app reports a storage permission error, open Termux, run `termux-setup-storage`, approve the Android permission prompt, and restart Termux.

## Verification status

- Frontend tests: 74 passed.
- Java tests: 55 + 5 + 206 checks passed; Java compilation against the repository's Android stubs passed.
- Asset check: 18 assets, 0 problems.
- Daemon Python syntax and the generated updater shell syntax were checked. The updater was exercised in a temporary test HOME and installed the bundled daemon files successfully.
- The full daemon unittest suite timed out in this environment with a socket timeout traceback, so it is **not** reported as passing.
- No APK build or real Android-device test was performed. The final path must still be verified on the user's phone.
