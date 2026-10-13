# Workspace switch recovery fix v5

## Symptom addressed

The Health/ SI screen can report that an OpenCode server is running for project `dd` while the selected project is `new1`, and refuse to switch because the app's persisted `oc.managed` flag is missing or stale.

## Change

When the server reports a different directory and SI does not currently remember ownership, SI now asks Termux to validate the launcher PID file. It treats the process as app-managed only when all checks agree:

- the PID file exists and contains a numeric PID;
- `/proc/<pid>/cmdline` exists;
- the live command is `opencode serve` on the configured port;
- the process working directory matches the server-reported directory.

Only then does SI restore its managed-state preferences and use its existing guarded stop/restart path to switch workspaces. Active tasks still block a switch. If ownership cannot be proven, the server is left untouched and the UI reports a workspace mismatch.

## Validation

- Java source compilation against included Android/JSON stubs: passed.
- OpenCode lifecycle tests: 206 checks, 0 failed, including lost-app-state ownership recovery and refusal to stop an unverified foreign server.
- Frontend tests: 53 passed, 0 failed.
- Asset check: 17 assets, 0 problems.
- Daemon test suite: execution timed out in this environment; not claimed as passed.
- Android device test: not performed. Device testing is still required.
