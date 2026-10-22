# Existing Projects, Chat Recovery, and Storage Picker Fix

## Changes

- The SI chat now keeps a memory-only transcript snapshot while switching project routes. Returning to a project renders the cached transcript immediately and refreshes it from the OpenCode session history. A temporary history-read failure no longer deliberately blanks the conversation. OpenCode remains the durable transcript source; chat text is not added to localStorage.
- Projects now has an **Open existing folder** action. It registers the selected existing directory as a project without creating a nested directory, then opens that exact root for SI, Files, Terminal, and Git.
- The Termux daemon advertises and implements `POST /v1/projects/open-existing`. The selected directory must exist and be accessible to Termux. Existing-project registration is persisted separately from the directory itself.
- Existing folders opened this way are non-owning registrations. **Remove from SI** unregisters the folder and preserves its files. Renaming the SI entry changes the registration name, not the original folder name.
- Android's SAF tree picker now maps primary shared storage and standard mounted removable-volume IDs to filesystem paths. Persistable URI permissions are retained when the provider grants them.
- The daemon accepts a removable-volume path only when that volume is mounted and the directory is actually accessible to Termux. Generic cloud/document providers cannot be edited through the current Termux filesystem backend and are reported as unsupported instead of being treated as ordinary paths.
- The daemon bundle is refreshed, and the native bridge updates an older daemon before using the new existing-folder endpoint.

## Verification performed

- Frontend test suite: 104 tests passed.
- Java compile/lifecycle suite: passed when run directly with the repository's Android stubs.
- Asset check: 18 assets, 0 problems.
- Targeted daemon integration test for exact-folder registration and safe removal: passed.
- Full daemon suite was attempted but did not finish within the execution time limit in this environment; it is not claimed as a complete pass.
- No physical Android device test or APK build was performed in this environment. Validate the native picker and removable storage on-device after building the updated app.
