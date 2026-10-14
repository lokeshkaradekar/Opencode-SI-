# Thinking indicator fix v11

## Confirmed source defect
The chat renderer's fast-path check compared `hist.length` with `lastHist.length`, but `lastHist` pointed to the same mutable array as `Agent.history`. After appending messages, both expressions saw the new length, so the renderer could incorrectly decide that the transcript had not changed and update only the live activity node. This could leave newer chat messages unrendered and make the activity UI appear inconsistent after repeated turns.

## Change
- Track `lastHistLength` as a numeric snapshot from the last full render.
- Only patch the activity node in place when the history length is unchanged.
- Force a full transcript render whenever new messages/activity records have been appended.
- Preserve the existing near-bottom scroll behavior and per-record expand/collapse state.

## Verification
- `node --test tests/frontend/agent.test.js` passed: 20 tests.
- Full frontend suite and asset checks are run before packaging.
- This is source-level verification; Android WebView behavior still needs device testing.
