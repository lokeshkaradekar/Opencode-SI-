# OpenCode SI — Sketchware Pro file layout (corrected)

This is a manual source-transfer package arranged to match the two Sketchware managers shown in your screenshots. It is not a native Sketchware project backup and is not a compiled APK.

## Java/Kotlin Manager
The `.java` files are directly inside `Java-Kotlin-Manager/`, matching the list in Java/Kotlin Manager. Import or replace them using the manager's available options. Do not create duplicate class entries. Back up your current project first.

## Assets Manager
`Assets-Manager/` mirrors the complete source `app/` directory:
- `css/`
- `dev/`
- `java/`
- `js/`
- `setup/`
- `dev.html`
- `index.html`
- `opencode-splash.jpg`

Copy/merge the contents into the corresponding paths in Sketchware's Assets Manager, preserving paths. Do not place the whole `Assets-Manager` folder inside assets; copy its contents. The `java/` directory inside Assets Manager is preserved separately from Java/Kotlin Manager's class entries because it exists in your screenshot and source tree.

## Termux runtime
`Termux-Runtime/daemon/` is for the Python daemon in Termux, not Android Java classes. `daemon-bundle.tar.gz` is included if present in the source app setup folder.

## Precautions
- Back up your Sketchware project before replacing anything.
- This source snapshot includes modularized daemon code. Ensure `Assets-Manager/setup/daemon-bundle.tar.gz` matches that daemon source; don't ship a stale bundle with newer Python modules.
- Sketchware compilation and physical-device behavior have not been verified by preparing this archive. Build a test APK and verify startup, server connection, file browser, terminal and Git before replacing your working APK.
