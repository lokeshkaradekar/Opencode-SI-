# OpenCode SI v39 — chunked Termux setup-bundle transfer

## Failure addressed
The setup screen showed `SETUP_START_FAILED` / `Could not prepare the setup bundle in Termux` and `No installer log yet.` This happens before the installer script runs. v38 passed the complete compressed asset as one `RUN_COMMAND` argument. The bundle is about 200 KB compressed (roughly 267 KB as base64), which can exceed Android Binder/Intent transaction limits; Termux can reject the request before `setup.log` exists.

## Change
- Transfer the base64 payload to Termux in 10,000-character chunks, each acknowledged by a short `RUN_COMMAND` result.
- Decode and validate the archive in Termux before starting the installer.
- Verify the installer script exists before reporting that setup started.
- Include Termux's actual error/stderr/stdout in a setup-start failure.
- Reuse chunked transfer for daemon refresh/custom-path updates too.
- Failed chunk transfers report the failed chunk number and keep setup pending so the user can retry.

## Limitations
This is a source-level fix. It has not been verified on a physical Android device. Android/Termux permissions, package installation, and OpenCode download still need device validation.
