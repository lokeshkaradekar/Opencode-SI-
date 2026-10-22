# v23 — Compact assistant transcript during live updates

## Change

While an OpenCode task is running, the current assistant turn in the chat transcript is reduced to its first sentence (or a short 180-character preview if no sentence boundary has arrived yet). The full incoming public assistant text remains in the expandable **Live assistant update** event card. This avoids showing a very large duplicate blue message above the live activity card.

After the task reaches a terminal state, the full assistant reply is displayed in the transcript as usual. User prompts, previous completed replies, command events, and tool outputs are unchanged.

## Validation

- Frontend tests: 126 passed.
- Java tests: 230 lifecycle checks passed, plus 55 general and 5 compatibility checks.
- Asset build: 18 assets checked, 0 problems.
- Physical Android/Sketchware device test: not performed.
