# v36 — Termux storage setup and manual fallback

- Storage setup is now idempotent: if `$HOME/storage/shared` is already readable and writable, the app reports that state and does not rerun `termux-setup-storage` (which otherwise prompts to rebuild existing links and can hang through non-interactive RUN_COMMAND).
- If storage links/access are missing, the app requests Termux's built-in setup command. The command result is not treated as proof that the selected workspace is accessible; the existing live workspace check remains authoritative.
- When automatic setup is blocked, the UI offers a copied multi-command checklist and explicit steps for Android permission review, correct `~/storage/shared` paths, creating/checking `Download/opencode-si`, returning to SI, and using Check again.
- The home setup banner remains pending until the live required checks pass; no completion flag is trusted on its own.

## Verification

- `npm run test:frontend`: 92 passed, 0 failed.
- `npm run build`: 18 assets checked, 0 problems.
- Java test runner compiled the Java sources against test stubs and passed its first 55 checks plus 5 project-menu checks, but the lifecycle test process did not finish within the 110-second limit in this environment.
- No APK build or physical-device test was performed. Android permission prompts and Termux RUN_COMMAND behavior still require device verification.
