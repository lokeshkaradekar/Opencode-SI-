# OpenCode SI v13 — Persistent Thinking Indicator

## Root cause addressed

The live activity card was rendered as an ordinary item inside `.chat-list`, the vertically scrolling transcript. When the conversation grew, that card could be scrolled out of the visible viewport even while the header still showed `SI task · working`. Increasing Android display DPI changes how many chat rows fit on screen, making the problem easier to notice, but the live indicator should not depend on transcript position.

## Change

- The active `Thinking`/tool activity card is rendered in `.active-activity-dock`, inside the fixed bottom chat dock immediately above the composer.
- The live card is omitted from the scrollable transcript while active, preventing duplicate cards.
- Completed activity cards remain in the transcript for history.
- The activity dock updates on each redraw/poll and keeps its expanded detail area bounded on small screens.
- Expanding/collapsing the live card triggers a redraw of the dock too.

## Validation performed

- `node --check app/js/agent.js` — passed.
- `npm run test:frontend` — 70 tests passed.
- `npm run build` — 17 assets checked, 0 problems.

This is source-level validation only. The updated app has not been built and tested on the user's physical Android device. Apply the source to the existing Sketchware Pro project and test at least ten messages, including messages that make the transcript scroll.
