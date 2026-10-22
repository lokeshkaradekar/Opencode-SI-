# Storage picker permission fix

## Root cause

The native Android bridge was checking `java.io.File.canRead()` / `canWrite()` in the OpenCode SI app's process immediately after Android's Storage Access Framework picker returned a path. Those checks run under the app UID, not the separate Termux UID that actually reads and edits project files. Scoped-storage rules can therefore reject a path that Termux can use, and the result is not a valid test of backend access.

## Changes

- The picker now validates the path format and passes it to the Termux daemon instead of making a misleading permission decision in the Android app process.
- The Termux daemon is the source of truth: existing-project registration checks that the selected directory exists and is readable, writable, and searchable by Termux.
- Shared-storage failures return `STORAGE_PERMISSION_REQUIRED` with instructions to run `termux-setup-storage`, approve permission, restart Termux, and retry.
- Removable-volume failures explain that SAF selection alone does not grant Termux filesystem access; the volume must be mounted and accessible to Termux.
- The packaged daemon bundle is regenerated so Health → Setup can deploy the updated daemon, rather than silently restoring the older behavior.

## Limits

This fixes the false rejection caused by checking permissions under the wrong Android UID. It does not make every Android document provider or SD-card filesystem accessible to Termux. Android's SAF URI grant belongs to the app and is not automatically transferable to Termux. If the Termux process cannot access a volume by filesystem path, a separate document-provider file bridge or a Termux-accessible project copy is still required.

## Verification

- Frontend tests: 104 passed.
- Java tests: 55 checks passed; project-menu compatibility: 5 checks passed.
- Full daemon test run did not finish within the available test window; no physical Android device test has been performed.
