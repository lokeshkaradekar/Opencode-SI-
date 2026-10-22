# v33 — Tool abort status fix

## Symptom
A task can end with the UI message `Stopped. Work already done stays on disk...` even though the user did not press Stop. The server may return an `AbortError` for a rejected/aborted tool call.

## Fix
`OpenCodeAgent.interpret()` now marks a task `CANCELLED` only when SI has an explicit user cancellation request. An `AbortError` returned by OpenCode is shown as `FAILED` with the server's real message, rather than being mislabeled as user cancellation. The task instruction also tells the model to verify tool-call execution and avoid treating rejected calls as completed.

## Scope and limits
This fixes incorrect status classification and improves recovery guidance. It cannot by itself force an upstream OpenCode provider/tool call to execute; if the server rejects it, the actual error is now visible instead of a misleading Stop message.

## Validation
The Java lifecycle regression test includes a fake server `AbortError` and asserts it is `FAILED` unless SI explicitly requested cancellation. Automated tests are not a physical Android/Termux device test.
