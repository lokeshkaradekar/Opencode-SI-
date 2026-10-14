# OpenCode SI v28 — stuck Thinking watchdog

## What this changes
- The chat continues to poll the real OpenCode task status. If the server still reports RUNNING after five minutes, the UI sends a cancellation request and shows a visible failure message with the next diagnostic step instead of remaining in Thinking forever. It does not fabricate an assistant reply or mark the task successful.
- The native OpenCode message request now has a six-minute read timeout rather than waiting indefinitely on a provider stream.
- Added a frontend regression test for a task that remains RUNNING past the watchdog deadline.

## Diagnosis still required if it triggers
Open Health → OpenCode diagnostics and inspect provider/model configuration and server logs. The watchdog prevents an endless UI state; it does not itself repair an invalid API key, unavailable model, provider outage, or network failure.

## Verification limits
Run frontend and Java test suites locally. This source ZIP has not been built as an APK or verified on a physical Android device.
