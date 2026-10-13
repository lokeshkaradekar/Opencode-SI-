# Auto Setup & Repair — v32

## What changed

- The Health screen now exposes **Auto Setup & Repair** when the local environment is unhealthy or has not been checked yet.
- The button opens the existing setup wizard, which performs real checks and can install/repair the bundled daemon and OpenCode runtime, then verifies service readiness.
- The one-time Termux recovery command now replaces an existing `allow-external-apps` property instead of appending a duplicate. It then invokes `termux-setup-storage` so Android can show the storage permission flow.
- The wizard explains that the command must be pasted into Termux when external command execution is blocked. This is intentional: a blocked `RUN_COMMAND` cannot safely enable itself through that same blocked channel.
- The UI never marks the setup successful just because a command was launched. It requires the real follow-up checks.

## What still requires user action

Android/Termux security restrictions mean the app cannot silently grant its own `RUN_COMMAND` permission, change Termux's private configuration through an unsupported cross-app filesystem shortcut, or approve Android storage access. On first setup, the user must copy the one-time command, open Termux, paste it, approve the Android storage prompt if shown, then fully restart Termux and tap **Check again**. After this one-time prerequisite, SI can use the existing installer and repair workflow automatically where supported.

## Safety

- Does not delete project files.
- Does not modify project source to repair the environment.
- Does not assume success based on elapsed time or an accepted intent.
- Uses the existing setup checks and server health probe as the source of truth.
