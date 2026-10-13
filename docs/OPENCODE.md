# OpenCode integration (AI tab)

The AI tab talks to the **official OpenCode agent**. OpenCode SI starts and manages `opencode serve` in Termux itself;
you never type `opencode serve` by hand.

```
UI (agent.js) -> NativeBridge -> OpenCodeAgent -> OpenCodeClient --HTTP 127.0.0.1:4096--> opencode serve (Termux) -> model provider
                      |
                      +-> OpenCodeServer (lifecycle) -> TermuxBackend.runScript -> Termux RUN_COMMAND (background)
```

## One-time setup (explained, nothing is changed silently)
1. Install Termux (F-Droid / GitHub build) and OpenCode in Termux (`opencode --version` must work). Tested: `1.18.33-termux`.
2. In Termux, allow apps to run commands (this is what lets OpenCode SI start the server):
   ```
   mkdir -p ~/.termux && echo 'allow-external-apps = true' >> ~/.termux/termux.properties
   termux-setup-storage        # only if the workspace is in /storage/emulated/0/...
   ```
   Fully close Termux (Exit in its notification) and open it once. To undo: delete that line. `daemon/termux-setup.sh` does the first line for you.
3. Open OpenCode SI. Grant the **Termux permission** when asked (RUN_COMMAND). The setup sheet (**Settings > OpenCode agent > Setup check**) runs 12 real checks
   (Termux installed, permission, external commands accepted, executable found, it runs, version, folder accessible, server running, health, providers, test session)
   and offers buttons: *Grant Termux permission*, *Open app settings*, *Open Termux*, *Check again*, *Start OpenCode*.
4. Manifest (Sketchware): unchanged from `SKETCHWARE_SETUP.md` (INTERNET, `com.termux.permission.RUN_COMMAND`, `<queries>` for `com.termux`, cleartext to 127.0.0.1).
   No new permission, service or receiver is declared: the result receiver for Termux is registered in code.

## What happens when the app opens
`opencodeStatus` -> `opencodeEnsure`: check Termux -> probe `GET /global/health` -> healthy: reuse (never a duplicate) -> down: run the start script through
`RUN_COMMAND` in **background mode** (no Termux window) -> poll health with back-off (default 60 s) -> `READY`. `READY` is set only from a real health answer.
States: `NOT_CONFIGURED, CHECKING_TERMUX, CHECKING_SERVER, STARTING_SERVER, WAITING_FOR_HEALTH, READY, CONNECTION_FAILED, AUTHENTICATION_FAILED, SERVER_STOPPED, RESTARTING, STOPPING`.
The indicator shows: Starting OpenCode / Connecting / Ready / Reconnecting / Connection lost / Setup required / Authentication required / Startup failed.
Tap it for details, *Diagnostics* (log of probes, Termux results, tail of the server log; secrets scrubbed), *Stop server*, *Setup check*.

Safety rules in the code: one startup at a time per process (`OpenCodeRuntime` is process-wide, so Activity recreation cannot start a second server); one launch per attempt;
cool-down after a failure for automatic triggers (explicit *Retry* bypasses it); an occupied port that is not OpenCode is reported (`PORT_CONFLICT`) and never killed;
a server that is already running is reused only if it works in the wanted folder (`WORKSPACE_MISMATCH` otherwise); only a server **this app started** can be stopped, and the stop
script re-verifies the pid file against `/proc/<pid>/cmdline` (`opencode … serve … --port N`) before killing the process group it created.

## Workspace
Default `/storage/emulated/0/Download/opencode-si`; change it in Settings (text field or *Pick…* folder picker; internal storage only). Validated: absolute, no `.`/`..`,
no control/shell characters, only shared storage or Termux home, never the whole storage root. Passed to Termux as a positional argument (never spliced into a script).
Two modes: **Chosen folder** (default) and **Follow open project** (`~/OpenCodeProjects/<project>`, so Files/Git/Terminal and undo snapshots see the same folder).
In *Chosen folder* mode the daemon-based Files/Git/Terminal tabs do not show that folder (they only serve `~/OpenCodeProjects`). If the folder is not accessible you get an error; the app never falls back to another directory. Changing the folder restarts a server this app started (refused while a task runs); a foreign server is never restarted.

## Chat, models, long tasks
* `agentStart/Send/Status/Cancel/Resume/History` (same names as before) now drive OpenCode: `POST /session`, `POST /session/{id}/message`, `GET /session/{id}/message`, `POST /session/{id}/abort`.
  The old daemon agent gateway is no longer reachable from the bridge (a test enforces it). Legacy provider screens remain only as a compatibility probe, collapsed in Settings.
* The message POST has **no read timeout** (it runs on its own thread); connect/health/other calls have their own short timeouts; startup has its own bound.
* After a dropped connection the app reads the session log back. It re-sends **only** if OpenCode never received the message; if it received it and the run finished -> `SUCCESS`; if it
  shows no further progress for 30 s -> `UNCERTAIN` (never reported as success). The session id survives app restarts; the transcript is re-read from OpenCode (not stored in the WebView).
* Models: read from the running server (`GET /config/providers`), else from `opencode models` in Termux. **Auto** sends no model, so OpenCode's own configuration/agent applies.
  The app does not switch models by itself; it does not claim automatic switching.
* Authentication: the app generates a random password (Android Keystore) and starts the server with `OPENCODE_SERVER_PASSWORD`; requests use HTTP Basic (user `opencode`).
  The app then checks whether an anonymous request is refused and tells you if it is not.

## Plan / Build
The chat header has a **Build | Plan** switch (per project, remembered). **Build** sends no agent field and uses the server's normal agent. **Plan** sends `agent: plan`.
Some OpenCode installations/configurations do not expose a Plan agent. On an app-managed server, the app can install a global `~/.config/opencode/agents/plan.md` only when no user file exists, then safely restart the server it owns and verify the agent list again. The generated agent denies file edits and asks before shell execution. It never overwrites an existing user-defined Plan agent. If the server is externally managed, the app will not kill it; the user must restart that server for the new agent configuration to load. A Plan request is not reported as successful unless the server actually accepts and completes it.

## AI task history (Files tab)
The Files tab has an **AI tasks** shelf: a persistent, per-project list of tasks you have run. It stores **metadata only** — task label, mode, outcome,
step/change counts, the undo snapshot id — capped at 30 per project. The conversation itself is never copied into the WebView's storage; reopening a task
reads the transcript back from OpenCode (`Agent.openSession`). Tapping a task opens its details with *Open in AI* and (when a snapshot exists) *Undo*,
which restores the project through the daemon's rollback (a safety snapshot is taken first).
Live state (a task in progress) is shown from the agent's own status; when a task ends the `opencode.task` event triggers an immediate status read,
so the shelf and the chat never wait for the next poll tick. Neither is animated: no scripted progress, no invented state.

## Troubleshooting
| Symptom | Meaning / fix |
|---|---|
| *Setup required: PERMISSION_MISSING* | Grant the Termux permission (button) or app settings > Permissions. |
| Permission granted but *PERMISSION_DENIED / refused* | `allow-external-apps = true` missing, or Termux not restarted after adding it. |
| *OPENCODE_NOT_FOUND* | `opencode` is not on Termux's PATH; run `command -v opencode` in Termux. |
| *WORKSPACE_INACCESSIBLE* | Run `termux-setup-storage`; check the folder exists. |
| *STARTUP_TIMEOUT* | Open Diagnostics for the server log tail. Android may be limiting Termux in the background (disable battery optimisation for Termux and OpenCode SI). |
| *PORT_CONFLICT* | Something else uses port 4096. Nothing was killed. Free the port or change `oc.port`. |
| *AUTHENTICATION_FAILED* | A server you started by hand has a password. Stop it, or enter its password in Settings. |
| *WORKSPACE_MISMATCH* | A foreign OpenCode server runs for another folder. Stop it in Termux or pick that folder. |
| Task result *UNCERTAIN* | The connection broke mid-run. Check Git/changes, then *Continue session*. |

## Known limits
Android can freeze or kill the app and Termux processes in the background; the app detects this and recovers, but cannot prevent it. No foreground service is used: the server lives in
Termux's process tree, and the app's in-flight request can be lost (handled as above). `POST /session/{id}/abort`, `/doc`, `/path`, `/config/providers` follow OpenCode's published API and
were **not** run against 1.18.33-termux from the build environment: unsupported routes are reported as `OPENCODE_UNSUPPORTED`.
