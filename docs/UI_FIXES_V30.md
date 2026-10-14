# OpenCode SI v30 — workspace line and Light-theme contrast

## Fixes
- Scoped the Health progress connector pseudo-element to `.loop .seg`; workspace mode buttons use `.oc-ws .seg` and no longer inherit the horizontal progress line.
- Added Light-theme CSS text-fill overrides for theme cards, settings panels, workspace controls, and Health/status labels while preserving semantic success/warning/error colours and white text on blue active controls.

## Validation
Frontend tests and asset validation should be run before packaging. Device rendering still needs testing on Android WebView.
