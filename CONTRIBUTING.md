# Contributing

Thanks for helping improve OpenCode SI. Small, focused pull requests and reproducible bug reports are easiest to review.

## Before opening a pull request

1. Read `README.md`, `docs/STATUS.md`, and `SECURITY.md`.
2. Keep implementation status accurate. Label real-device-dependent work as unverified until tested on a device.
3. Do not add secrets, API keys, daemon tokens, private project files, or personal data to commits, screenshots, or logs.
4. Preserve production/dev separation: `app/dev/` and `app/dev.html` are development-only.

## Run checks

```bash
npm test
npm run build
```

The test environment does not replace a Sketchware build or physical Android test. For changes affecting Android lifecycle, Termux intents, permissions, storage, WebView rendering, or server startup, include device/OS/Termux/Sketchware versions and manual test results.

## Bug reports

Include expected and actual behaviour, exact reproduction steps, Android version, device architecture, Termux and Sketchware Pro versions, source revision, sanitized setup logs, and whether the issue reproduces on a clean project. Remove API keys, passwords, daemon tokens, usernames, and private paths before sharing logs.
