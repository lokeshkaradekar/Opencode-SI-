# Project location picker and workspace control theme fix

## New project location
- New Project asks for a name, then offers the default `~/OpenCodeProjects` location or a custom parent folder picker.
- Custom location creates `<selected-parent>/<project-name>/README.md`.
- The daemon keeps a small `.si-project-paths.json` registry inside `~/OpenCodeProjects`, so custom projects remain visible after daemon/app restarts and are available to Files, Git, Terminal and the agent through the same project ID.
- Custom parent folders must already exist and be inside Termux home or shared internal storage. Android folder picker can select internal-storage folders; Termux must have storage access to work with them.
- Rename updates the registered custom path. Delete removes the selected project directory, matching normal project delete semantics.

## Settings contrast
- Added theme-variable-driven styles for the Chosen folder / Follow open project segmented buttons, path input and Pick/Use folder buttons.
- These use `--panel`, `--panel-2`, `--line`, `--ink`, `--brand` and `--brand-ink`, so they adapt to all six built-in themes instead of using browser defaults or transparent white-on-white buttons.

## Validation
- Frontend tests: 74 passed.
- Asset build check: 17 assets, no problems.
- Command policy and project menu compatibility tests passed.
- Custom project path create/list/rename/delete smoke test passed on the host.
- Full Java lifecycle test command exceeded the execution time limit after the initial Java checks; no claim of full Java suite completion.
- No APK/device integration test was available in this environment.
