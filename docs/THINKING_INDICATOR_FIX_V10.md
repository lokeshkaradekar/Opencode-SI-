# Thinking indicator fix v10

## Reported issue
The Thinking/Working activity card appeared for the first couple of chats, then was absent even while the SI header indicated that a task was working.

## Change
- Added `ensureActiveActivity()` reconciliation to the agent adapter.
- Before each chat redraw, if the adapter says a task is working, the renderer ensures that exactly one live activity record (`Thinking` or real tool activity) exists and is visible at the end of the transcript.
- If a live record was detached from the history array, the same record object is reinserted so the existing poll loop continues updating the visible card rather than updating a hidden duplicate.
- If a live record was buried below later rows, it is moved to the visible end; repeated redraws reuse it instead of creating duplicate cards.
- Added regression tests for repeated redraws, missing live rows, and buried rows.

## Verification
Frontend agent tests are run for this package. This is source-level verification only; Sketchware/WebView device behavior must still be tested on the user's phone.
