# OpenCode SI — Same-name project recreation fix (v7)

## Problem
Deleting a project removed its folder, but the WebView kept per-project metadata keyed by the project ID. Because the project ID is its folder name, recreating a project with the same name could restore the old OpenCode session ID and old task list, making the new folder appear to continue the deleted project's work.

## Change
- Added `Agent.resetProjectData(projectId)` to clear the app-side session, task index, mode, legacy history/pending state, and editor tab metadata for a deleted project.
- It invalidates pending poll callbacks and clears in-memory chat state if that project is currently loaded.
- The project delete success handler calls this reset only after the filesystem deletion succeeds.
- Added a regression test proving a recreated same-name project does not inherit the cached session.

## Verification
- Frontend tests: 54 passed, 0 failed.
- Asset/build check: 17 assets checked, 0 problems.
- Android/Termux device test: not performed.

Note: this clears OpenCode SI's local reference to the old session; it does not delete historical sessions from OpenCode's own database. It prevents the new project from automatically reusing that old session.
