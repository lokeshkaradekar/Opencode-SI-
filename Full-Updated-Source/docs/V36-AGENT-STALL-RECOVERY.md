# v36 — Agent response stall recovery

## Problem addressed

The synchronous `POST /session/{id}/message` request can remain open for the entire model/tool run. If an upstream provider stream disappears without a terminal response, the app's worker can wait indefinitely even while the OpenCode server process remains reachable.

## Changes

- Bound the *HTTP response read* to 120 seconds. This is not a task deadline and does not cancel a long build/install.
- On a transport timeout, use the existing safe session-log reconciliation path. It checks whether the user message was accepted and never resends an accepted message.
- Keep polling the authoritative session log for terminal completion, provider/tool errors, and cancellation.
- Add a 15-minute inactivity watchdog only when the session log has not changed and no tool is `running` or `pending`. In that case, request the official session abort route and report `AGENT_STALLED` (or `UNCERTAIN` if abort cannot be confirmed).
- Do not auto-abort a live shell/build/install tool merely because its output is quiet.
- Log safe elapsed/stage diagnostics only; do not log prompts, response bodies, credentials, or model reasoning.

## Validation

- `npm run build`: passed (18 assets checked).
- Frontend regression suite: 136 passed, 0 failed.
- Java compile and lifecycle suite: 238 checks passed.
- Not yet verified on a physical Android device. The 120-second transport handoff and 15-minute model-stall threshold need real-device testing with the user's provider/model.

## Known limitation

This is client-side recovery. It cannot repair an OpenCode/provider bug itself. If the OpenCode session remains busy after an upstream stream dies, SI now tries to abort only when no tool is actively running and reports an explicit state instead of silently waiting forever. The provider's own `chunkTimeout`/request timeout should also be configured appropriately in the user's OpenCode provider configuration.
