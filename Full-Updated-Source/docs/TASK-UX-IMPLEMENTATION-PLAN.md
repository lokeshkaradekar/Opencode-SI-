# Task UX implementation plan

## Responsibilities and dependency direction
- `app/js/diff.js`: existing pure diff parser/renderer input; no dependency on UI or bridge.
- `app/js/git.js`: per-file review controls, review-state persistence, explicit file restore, and commit action. Depends on `Diff`, `Bridge`, `Persist`, `UI`, and `State`.
- `app/js/agent.js`: task/session lifecycle, pre-task snapshot IDs returned by NativeBridge, one-tap rollback, usage-history persistence, and resume UI. Depends on `Bridge`, `Persist`, `State`, and `Bus`.
- `app/js/bridge.js`: thin API wrappers for existing snapshot/usage operations and approval notification request.
- `app/java/NativeBridge.java`: snapshot creation for new and resumed tasks; returns snapshot ID for UI undo and exposes the approval-notification action.
- `app/java/TaskNotificationService.java`: posts task status, completion summary, and approval-needed notifications.
- `daemon/ocd_snap.py`: existing snapshot implementation; no new Git history is created in the user's project repository.

## Dependency constraints
`diff.js` must remain standalone. `git.js` and `agent.js` may depend on the bridge but must not import each other. NativeBridge delegates snapshot storage to the daemon endpoint; the daemon does not depend on UI code. No module should import `app.js`.

## Safety and semantics
- Review Accept records that the user reviewed a file; it does not commit it.
- Revert is per-file and confirms before restoring to the last committed version.
- Commit asks for an explicit message; the existing Git commit API commits all current changes, so the button clearly states this.
- Undo uses the last snapshot ID and requires confirmation; `ocd_snap.py` creates a safety snapshot before rollback.
- Usage history stores provider-reported fields only; absent cost remains null and is displayed as "Not reported".
- Session/task state persists through the existing `Persist` store. OpenCode remains the source of truth for the transcript.
