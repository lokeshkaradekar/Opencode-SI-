# OpenCode SI hotfix — 16 October 2026

## Included

- Hardened OpenCode server ownership recovery. The saved launcher PID is checked against the live OpenCode command, configured port, and workspace. If the process working directory differs from OpenCode's reported workspace, SI accepts it only when stdout still points to SI's private server log. When the PID record is missing or stale, fallback discovery requires a unique matching server whose stdout points to that private log. This tolerates cwd/log differences without taking over a manually started or unrelated server.
- Corrected removable-storage SAF mapping to accept Android-style volume IDs (`XXXX-XXXX`) rather than treating arbitrary document-provider IDs as filesystem paths.
- Reworked the chat header layout for narrow Android WebViews so status chips, Restart chat, and Build/Plan wrap in normal flow instead of overlapping. The recovery banner now acts as one bounded scroll container instead of nesting another height-limited card, keeping Retry/Details visible and preventing the transcript from appearing to overlap it.
- Increased the recovery banner's visible area and constrained recovery cards to their own scroll region, while keeping transcript and composer layers separate.

## Validation

- Java compile and lifecycle tests: 210 checks passed.
- Frontend tests: 104 passed.
- Asset check: 18 assets checked, 0 problems.
- Daemon tests were not verified in this environment (the command exceeded the available execution window).
- Physical Android/Termux device testing remains required.

## Storage caveat

A SAF tree URI is not automatically a filesystem path available to Termux. Primary shared storage requires Termux storage permission (`termux-setup-storage`); removable volumes must be mounted and readable/writable by Termux. Arbitrary document providers (for example, cloud drives) need a separate file bridge and cannot be made editable by OpenCode just by selecting them in Android's picker.
