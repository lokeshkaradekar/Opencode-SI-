# Reliability feature status — Phase 6 planning baseline

This document distinguishes existing source behavior from future work. It is not a claim of device-level validation.

| Feature | Current source status | Safe next implementation gate |
|---|---|---|
| Diff review / accept / revert / commit | Existing diff support is present; review the actual task integration before claiming every task is gated | One immutable per-task diff, explicit Accept/Revert/Commit, test overlapping agent tasks |
| Snapshot / undo last task | Snapshot APIs and `ocd_snap.py` exist | Snapshot before every task, verify snapshot belongs to task, one-tap restore with confirmation |
| Stop / resume | Cancel/status hooks exist | Verify cancellation reaches the real worker; persist resumable session IDs and distinguish stopped from completed |
| Wi-Fi remote workspace | **Not implemented**; native `setBackend(remote)` returns `NOT_IMPLEMENTED` | Follow `REMOTE_WORKSPACE_WIFI_DESIGN.md`; don't expose success UI before routing all workspace and agent operations |
| Multiple session tabs | OpenCode session listing APIs exist; independent UI/workspace state needs validation | Isolate session ID, project ID, model, pending task and transcript per tab; prevent cross-project writes |
| ZIP backup / GitHub push | No complete one-tap backup flow confirmed in this baseline | Export project files only, exclude secrets/cache/.git internals as chosen by user; preview size; GitHub push must be opt-in and token-safe |
| Voice task input | No complete native voice implementation confirmed | Use platform-supported recognition only when available; graceful text fallback, explicit microphone permission and no background recording |
| Plugins / MCP | No complete in-app plugin management confirmed | Show only capabilities advertised by the selected OpenCode server; never assume arbitrary MCP support |
| Audit log | Native bounded local audit log exists and the agent UI has a viewer | Add filtering/search/export of redacted records; verify every sensitive operation is logged without arguments or secrets |
| Crash/error report | Redaction helper and diagnostics surfaces exist | One-tap copy/export of redacted diagnostics; preview before sharing; exclude tokens, prompts, file contents, full paths where unnecessary |
| On-device health checklist | Health screen and real checks exist | Add explicit Git/terminal/permissions/project read-write checks; separate warning from hard failure and avoid destructive tests |

## Validation rule

Run `npm test` and `npm run build` after changes. These checks do not prove APK compilation or physical-device behavior. Final acceptance still requires importing the Java and asset folders into the existing Sketchware Pro project and testing the built APK on-device. Do not change that workflow as part of this phase.
