# Auto Setup & Repair — v33

## Persistence behavior

- Setup state is computed from live native setup checks; it is not inferred from a localStorage flag saying the wizard was shown.
- The Home screen shows a persistent **Finish setting up OpenCode SI** card until all required local checks report `ok`.
- A cold launch re-runs the checks and re-opens the setup wizard if setup remains incomplete. Dismissing the wizard does not mark setup complete.
- The Home card's **Check again** action refreshes the live setup state. Wizard check results also trigger a Home refresh so the card disappears after verification.

## Automatic and manual recovery

- The wizard still attempts supported repair/install actions first.
- If Termux blocks external command execution, the wizard cannot modify `~/.termux/termux.properties` through the blocked command channel. It displays a copyable command and numbered instructions to paste it into Termux, approve storage access, fully restart Termux, and re-check.
- If shared-storage access is missing, it tries `termux-setup-storage` through the supported command bridge. If blocked or unsuccessful, it provides the command and step-by-step manual fallback.
- Setup is only considered complete when the required live checks report `ok`: Termux installed, RUN_COMMAND permission, external commands, workspace read/write, OpenCode executable and version invocation, server health, and test session.
- No project folders or project contents are deleted by these changes.

## Validation

- Frontend tests: 88 passed.
- Asset/build validation: 18 assets checked, 0 problems.
- Java lifecycle tests: 55 checks + 5 project-menu compatibility checks + 206 OpenCode lifecycle checks passed.
- Physical device testing is still required for Termux's Android permission dialogs and external-command behavior.
- Shared-storage repair now uses a dedicated native bridge method for the single fixed `termux-setup-storage` command (not the project terminal/daemon). If Termux refuses it or no result is returned, the wizard still presents the manual copy/paste fallback.
