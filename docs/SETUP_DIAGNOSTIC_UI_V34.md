# OpenCode SI v34 — setup diagnostic and layout correction

## What the screenshots show

- The user ran `termux-setup-storage` twice and accepted the rebuild confirmation. The command returned to the Termux prompt, so this command appears to have finished.
- That command rebuilds Termux shared-storage links; it does **not** enable `allow-external-apps`. The separate RunCommandService error indicates external command access is still blocked or was not diagnosed correctly.
- The setup UI displayed `termux-setup-storage` vertically because the `<pre>` used the generic `code` class, which is globally sized as a 22px code-change icon.

## v34 changes

- Give setup command/log blocks dedicated full-width, min-width-safe styles; remove the conflicting `code` class.
- Treat delivered Termux results with an error or nonzero exit code as failures; specifically recognize `allow-external-apps`/RunCommandService errors rather than incorrectly reporting external command access as OK.
- Make the workspace message distinguish a missing folder from a permission problem.
- Clarify that storage setup and external-command permission are separate steps.

## Manual recovery if external command access is blocked

Open Termux directly and run `nano ~/.termux/termux.properties` (create the parent directory first if needed). Add or update `allow-external-apps = true`, save, then fully close and reopen Termux. The user must do this manually because the app cannot run the command that would enable the very external-command channel currently blocked. Then return to SI and rerun setup checks.

## Validation

Source-level tests are included for the narrow command-panel layout and delivered-error diagnosis. Physical Android/Sketchware testing is not claimed.
