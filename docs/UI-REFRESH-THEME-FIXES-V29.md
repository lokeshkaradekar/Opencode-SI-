# OpenCode SI v29 — UI polish and pull-to-refresh

## Changes
- Task outcome cards now have a clear completion header, status badge, accent border and consistent spacing.
- OpenCode server action buttons use a shared responsive grid. Stop server has a visible border and warning colour rather than looking like an unboxed text action.
- Added a pull-down refresh gesture when the active scroll area is at the top. It re-renders the current screen and re-checks OpenCode/Health without restarting the Android app.
- Explicitly applies theme text tokens to theme-picker cards so the Light theme uses readable dark text.

## Verification
- `npm run test:frontend`: 79 passed.
- `npm run build`: 18 assets checked, 0 problems.
- `timeout 170s bash tests/java/run.sh`: 55 checks passed, project-menu compatibility 5 checks passed, daemon scripts passed, OpenCode lifecycle 206 checks passed, Java compile passed.
- Not tested on a physical Android device. Pull-to-refresh gesture, visual appearance and Sketchware APK integration still require device verification.
