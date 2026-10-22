# OpenCode SI task recovery and chat scrolling fix

This update changes the existing application; it does not replace the Termux/OpenCode architecture.

## Changes
- `app/js/agent.js`
  - A server-reported `RUNNING` task is no longer automatically cancelled solely because a five-minute foreground timer elapsed.
  - The live activity shows a non-destructive long-running notice and keeps the Stop control available.
  - Added a foreground reconciliation hook that nudges the existing poll loop or starts one if it no longer exists.
  - Existing bounded retries still surface actual status-request failures; terminal states are taken from the server rather than guessed.
- `app/js/app.js`
  - On Android resume and WebView visibility restoration, clear background accounting, resume OpenCode checks, and reconcile an active task.
- `app/css/components.css`
  - Long session/interruption banners are constrained to a scrollable region.
  - Long resume cards and expanded activity details can scroll without pushing the composer and bottom navigation out of view.
- `tests/frontend/agent.test.js`
  - Updated watchdog regression coverage to verify that long-running server tasks are not auto-cancelled and can complete normally.

## Verification
- Frontend tests: 103 passed.
- Java tests: 208 checks passed.
- Asset validation: 18 assets checked, 0 problems.
- JavaScript syntax checks passed.

## Device verification still required
Automated tests cannot prove that Android/OEM battery management keeps Termux and the provider network active on a physical device. Test with the screen off and check whether the daemon remains reachable. If Android stops Termux, configure the device's supported background/battery settings for Termux and OpenCode SI; this package does not acquire an indefinite wake lock or promise that Android will never suspend a process.
