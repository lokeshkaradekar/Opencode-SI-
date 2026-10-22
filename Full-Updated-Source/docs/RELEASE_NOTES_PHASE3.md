# Phase 3 source update — release quality

## Included in this source snapshot

- Built-in task templates for bug fixes, features, code review, tests, and release readiness.
- User-defined task templates: create, edit, select, and delete up to 20 templates stored locally in WebView storage.
- Template names are limited to 60 characters and prompts to 4,000 characters. Saving a template never sends a task; selecting one only fills the composer.
- Java lifecycle test output preserves individual failing check names. The watchdog timing test uses a less aggressive threshold/window to reduce scheduler-related flakiness.
- Historical version-specific notes are retained under `docs/archive/`; current setup, status, and roadmap docs remain in `docs/`.

## Validation in this source environment

- `node --check app/js/agent.js` — passed.
- `node --test tests/frontend/productivity-task-templates-phase3.test.js` — 5/5 passed.
- `node tools/check-assets.js` — 18 assets checked, no problems.
- `npm run test:metadata` — passed.

The complete daemon/frontend/Java test suite has not been re-run as one successful release gate for this snapshot. No physical Android device, Sketchware build, APK install, or real OpenCode server test is claimed.

## APK signing note

If an APK is built using the Sketchware test key, label it as a test build. Do not describe it as a production-signed release. This source package does not include a verified APK.

## Remaining release blockers

- Refactor `NativeBridge.java`, `OpenCodeServer.java`, and `agent.js` into smaller, testable modules.
- Extract prompts currently embedded in Java.
- Add a reproducible Android build and signing pipeline.
- Run the app on physical Android devices and record the device/OS matrix in `docs/STATUS.md`.
