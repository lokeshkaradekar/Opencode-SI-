# ocd.py API (all replies: {success,data,error:{code,message,details},requestId}; `Authorization: Bearer <token>`)

Sessions (PTY): POST /v1/sessions {project,cwd,cols,rows,env} · POST /v1/sessions/{id}/exec {command,timeout_ms,confirmed}
· POST .../stdin {data|data_b64} · .../interrupt (Ctrl+C key) · .../cancel (flagged + escalating) · .../resize · .../restart
· GET .../events?since=N&wait_ms=ms (long-poll cursor) · GET /v1/sessions/{id} · DELETE
Event types: session_start, ready, command_start, output, command_end{status,exit_code,cwd,duration_ms}, session_exit, session_restart.
Command states: RUNNING, SUCCESS, FAILED, CANCELLED, TIMEOUT.
Jobs (pipe): POST /v1/jobs {project,argv|command,cwd,env,timeout_ms,stdin,confirmed} · GET /v1/jobs/{id}/events · POST .../stdin|cancel
Files: POST /v1/fs/{list,stat,read,write,mkdir,rename,copy,delete,search}  · Projects: GET/POST /v1/projects · GET /v1/health

## Token hand-off (UNVERIFIED on device)
App and Termux are different Android users, so the app cannot read ~/.opencode-si/daemon.token. Plan: the app generates the token
(kept in Keystore-backed storage) and starts the daemon through Termux RUN_COMMAND with `--token-stdin` or OC_DAEMON_TOKEN.
Confirm the exact RUN_COMMAND extras supported by the installed Termux version before relying on it.

## Termux requirements
`pkg install python bash git nodejs`; Termux `allow-external-apps=true` and the RUN_COMMAND permission for the app (Termux:API is not required by the daemon).


## v0.2 additions (all `POST`, JSON body, `project` = folder name under the workspace)
- **Git** `/v1/git/{init,status,diff,log,branch,checkout,add,restore,commit,fetch,pull,push,stash,rev-parse,clone}` - argv-only (no shell),
  every ref/remote/path validated, repo-supplied hooks/fsmonitor/textconv/external-diff never executed, no credential prompts. Destructive
  operations (`restore` of changes, dirty `checkout`, force push, stash drop) answer `CONFIRMATION_REQUIRED` until `confirmed:true`.
  Clone accepts only `https://`, `ssh://`, `git@host:path`.
- **Snapshots** `/v1/snapshots/{create,list,inspect,rollback,delete}` - private git store in `<workspace>/.oc-snapshots/<project>.git`
  (never touches the project's own `.git`). Rollback needs `confirmed:true`, first takes a "Before rollback" snapshot, restores files,
  removes files that did not exist then, never follows symlinks out of the project. Excludes `node_modules`, `.venv`, build output and files >5 MB.
- **Detect** `/v1/projects/detect` - `{types, primary, package_manager, scripts, suggested, evidence}` from real project files.
- **Agent** `/v1/agent/{start,send,resume,cancel,status,models,probe}` - OpenAI-compatible tool-calling loop (`list_files, read_file, search,
  write_file, run_command`). Tools execute for real; `status.steps` is the real action log and `status.summary` is generated from it. The provider
  block `{base_url, model, api_key, needs_key}` is passed per request, held in memory, scrubbed from errors and never written to disk.
  States: `RUNNING | DONE | FAILED | CANCELLED | INTERRUPTED` (daemon died mid-run; `resume` continues from the saved transcript).
- **Maintenance** `/v1/maintenance/cleanup` - removes stale `.oc-*.tmp` files and agent sessions older than 14 days.
- Terminal/jobs now run with `GIT_CONFIG_*` env that disables `core.fsmonitor` and `protocol.ext`, so a hostile repo cannot execute code via the shell's own git.

## Project root mapping
Termux home `/data/data/com.termux/files/home` -> workspace `~/OpenCodeProjects` -> **one folder per project** = the app's project id.
The app's own private directory (`/data/data/com.opencode.mobile`) is **not** involved: Android UIDs cannot read each other's files, so every
file/terminal/git operation goes through the daemon. To get files in or out, use Termux (`cp`, `git`, `termux-setup-storage`).
