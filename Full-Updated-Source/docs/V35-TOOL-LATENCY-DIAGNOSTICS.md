# v35 — Tool latency diagnostics and polling efficiency

## Changes

- Active task polling still checks authoritative task status every 1.5 seconds.
- Full conversation-history synchronization is now limited to the first poll, every 5 seconds while running, and terminal-status ticks. The OpenCode event stream remains responsible for live public text deltas; status/tool activity polling is unchanged.
- The transcript-sync throttle resets when a project loads, a new task begins, or a task is resumed.
- Native diagnostics now record how long the blocking OpenCode message request took and the safe error code/details when it fails. No prompt text, response body, credentials, or tokens are logged.
- Server-reported model/tool errors remain failures; this patch does not automatically resend them. Transport recovery retains the existing duplicate-send safeguards.

## What this does and does not fix

This reduces repeated history HTTP requests during long tasks and makes it easier to distinguish a slow server/model request from a frontend history-polling overhead issue. It does not guarantee that an upstream OpenCode/provider `Tool execution aborted` error will disappear; that error can only be fixed after its underlying server/provider cause is identified.

## Validation

- `node --check app/js/agent.js`: passed.
- `npm run build`: 18 assets checked, 0 problems.
- Frontend regression suite: 136 passed, 0 failed.
- Java compile and lightweight policy/menu tests: compilation passed, 55 policy checks passed, 5 project-menu compatibility checks passed.
- Full Java lifecycle test did not finish within the 25-second execution window in this environment; no passing claim is made for that test.
- Physical Android device test not performed.
