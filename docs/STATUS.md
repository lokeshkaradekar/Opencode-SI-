# OpenCode SI — status

Legend: **COMPLETE** = implemented + integrated + tested + verified in this environment, no mock needed.
**PARTIAL** = works but with a stated gap. **NOT IMPLEMENTED**. **UNVERIFIED — ANDROID DEVICE TEST REQUIRED** = code exists, cannot be run here.

> **Version note:** `package.json` currently identifies the source package as `0.4.2`. The environment-specific test notes below were recorded against an earlier `0.4.0` snapshot and should not be read as fresh verification of every component in the current source.

Environment used for verification: Linux container, Python 3.12, Node 22, git, OpenJDK 21 (javac via `jdk.compiler`, source level 8). **No Android device, no android.jar, no Sketchware, no Termux, no internet.**

## Daemon (`daemon/`) — verified on Linux, not on Termux
| Component | Status | Evidence |
|---|---|---|
| Persistent PTY, cd persistence, stdin, Ctrl+C, cancel (INT→TERM→KILL), timeout, streaming | COMPLETE (Linux) | `test_daemon.py` (44 tests) |
| States RUNNING / SUCCESS / FAILED / CANCELLED / TIMEOUT | COMPLETE (Linux) | real exit codes/signals in tests |
| Shell crash recovery, process cleanup | COMPLETE (Linux) | tests 13–14 |
| Filesystem API (list/read/write/create/mkdir/delete/rename/search/stat, binary, large files, size limits) | COMPLETE (Linux) | `TestFilesystem` |
| Auth, loopback-only, Host/Origin checks, path traversal & symlink protection | COMPLETE (Linux) | `TestPolicyAndAuth`, `TestFilesystem` |
| Git API (status, diff, log, branch, checkout, add, restore, commit, fetch, pull, push, stash, rev-parse, init) | COMPLETE (Linux) | `test_extended.TestGit` incl. real local remote, arg-injection, hostile hooks/fsmonitor/textconv |
| Git clone | PARTIAL | URL validation tested; a real clone needs network (none here) |
| Snapshots: create/list/inspect/rollback/delete, safety snapshot, confirmation, symlink safety | COMPLETE (Linux) | `TestSnapshots` |
| Project type detection (node, npm/pnpm/yarn, react, vite, next, ts, python, js, git, rust, go) | COMPLETE (Linux) | `TestDetect` |
| Health (real PTY probe, real process spawn, git init probe, tools, workspace, storage, network) | COMPLETE (Linux) | `TestHealth`, `TestHealthV2` |
| Agent gateway: tool loop, real file writes / commands, failure reporting, snapshot-before-change, cancel, resume, key scrubbing, policy applies | COMPLETE against a scripted OpenAI-wire server | `TestAgent`. **Not run against a real model provider** (no network): UNVERIFIED with live providers |
| Provider probe / list models | COMPLETE against the scripted server; UNVERIFIED with real providers | `test_models_and_probe` |
| Anthropic-native / non-OpenAI wire protocols | NOT IMPLEMENTED | OpenAI-compatible only (OpenRouter, OpenAI, Ollama, llama.cpp, LM Studio…) |
| Running on Termux/Android | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | |

## Android Java (`app/java/`, package `com.opencode.mobile`)
| Component | Status | Evidence |
|---|---|---|
| All four files compile (Java 8 syntax, cross-references) | PARTIAL | `npm run test:java` compiles against **hand-written stubs**, not the real Android SDK |
| Terminal command allowlist (`CommandPolicy`) | COMPLETE (logic) | 55 checks, plain-Java test |
| `SecureStore` (Keystore AES-GCM, AAD, no plaintext fallback) | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | |
| `TermuxBackend` HTTP client, session/exec/streaming/cancel mapping | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | the daemon side it calls is tested; the Java client is not run |
| Daemon auto-start via Termux `RUN_COMMAND` + token hand-off on stdin | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | intent extras follow the Termux docs from memory |
| `NativeBridge` dispatch, response contract, provider config, health aggregation, repair | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | method list is contract-tested against the JS (`bridge.test.js`) |
| `MainActivity` hardened WebView, permission flow, lifecycle | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | |
| Sketchware import/build | UNVERIFIED — ANDROID DEVICE TEST REQUIRED | `docs/SKETCHWARE_SETUP.md` is untested on a device |

## Frontend (`app/`)
| Item | Status | Evidence |
|---|---|---|
| Production page never uses the mock; missing bridge ⇒ `BRIDGE_UNAVAILABLE` | COMPLETE | `bridge.test.js` |
| Mock isolated in `app/dev/` + `dev.html` | COMPLETE | test + `npm run build` |
| Bridge envelope handling, unknown-method refusal, events | COMPLETE | 10 tests |
| Terminal: live streaming, real statuses, stdin, Ctrl+C, stop, confirm-retry | COMPLETE (logic, simulated bridge) | `terminal.test.js` (6 tests). Rendering in a real WebView unverified |
| Files / editor / Git screens use the real bridge methods | PARTIAL | method existence is contract-tested; screens not exercised end-to-end |
| Agent screen polls the real action log; Undo = snapshot rollback | PARTIAL | logic reviewed, not UI-tested |
| Provider settings (URL, model, key, list models) | PARTIAL | not UI-tested |
| Recovery levels 3–4 (dependency repair / runtime switch), remote workspace, ZIP import | NOT IMPLEMENTED | return `NOT_IMPLEMENTED` honestly |

## Behaviour changes you should know about
- **The agent now edits files directly** (a snapshot is taken first; *Undo* restores it). The old "review proposals then Apply" flow was removed because a proposal-only agent cannot truly run commands.
- **A PTY merges stdout and stderr**; the terminal shows one stream.
- Recovery level 5 now restores **project files** from the last known-good snapshot (after confirmation); it no longer claims to touch only an "environment".
- The terminal allowlist is a safety rail, not a sandbox.

## Historical environment notes (source snapshot 0.4.0)

Two test failures in this workspace are **environmental, not regressions** (both fail before and after this change set):

- `npm run test:java` — 5 checks in the `REAL Termux scripts under bash` case fail because `tests/java/fixtures/fake-opencode.py` starts with `#!/usr/bin/env python3` and Android has no `/usr/bin` (env lives under the Termux prefix). The Plan/Build and all other cases pass (194 checks total).
- `npm run test:daemon` — `test_health_is_real` expects `termux: warning` because it was written for a non-Termux box; this workspace really is Termux, so the truthful health check correctly reports `ok`. 69/70 pass.

Verified green in this run: `npm run test:frontend` (28 tests), `npm run build` (17 assets).

## TODO/stub scan
Remaining `NOT_IMPLEMENTED` strings (ZIP import, recovery levels 3–4/6, remote backend) are intentional, honest errors. No `TODO`, `FIXME`, `UnsupportedOperationException` or mock fallbacks in production code. `app/dev/mock.js` is dev-only.

## OpenCode integration (added in 0.3.0)
Verified here = Linux container with JDK 21, Python 3.12, Node 22, real bash, real sockets/processes. **No Android SDK, no Gradle project, no device, no real OpenCode binary, no Termux.**

| Component | Status | Evidence |
|---|---|---|
| `OpenCodeServer` lifecycle: states, single-flight start, cool-down, bounded wait, ownership, port conflict, workspace mismatch/restart/busy, auth, setup checks | COMPLETE (logic) | `OpenCodeServerTest` (194 checks, scripted OpenCode HTTP server, real sockets) |
| Termux scripts START / STOP / PROBE (detach, pid file, password via env, foreign-pid refusal, group stop) | COMPLETE on Linux bash | same test, real bash + fake `opencode` executable (`tests/java/fixtures`) |
| `OpenCodeAgent`: async task, live steps, provider errors passed through, no double-send, UNCERTAIN, cancel honesty, model list/selection | COMPLETE against the scripted server | `OpenCodeServerTest` |
| Plan/Build mode: per-project choice, sent only for Plan (`agent: "plan"`), pre-checked against `GET /agent` (missing plan agent or unreadable list => honest refusal/proceed), unknown modes refused | COMPLETE against the scripted server | Plan-mode test in `OpenCodeServerTest`; the real agent-list route on 1.18.33-termux stays UNVERIFIED |
| Persistent AI task index (workspace shelf): metadata only, capped at 30 per project, never the transcript; reopen via `Agent.openSession` (transcript re-read from OpenCode); undo via the recorded snapshot | COMPLETE (logic) | `opencode.test.js` (12 tests) |
| Real-time reconcile: same-session `opencode.task` event triggers an immediate status read; the abandoned `agent:stream` listener was removed | COMPLETE (logic) | `opencode.test.js` |
| Agent screen, status chip, setup/diagnostics sheets, settings, Plan/Build control | PARTIAL | flow logic tested (`opencode.test.js`, 12 tests); rendering in a real WebView unverified |
| Real OpenCode 1.18.33-termux API behaviour beyond `/global/health`, `POST /session`, `POST /session/{id}/message` | UNVERIFIED - DEVICE TEST REQUIRED | the other routes, message/part JSON shape, `OPENCODE_SERVER_PASSWORD` behaviour follow public docs/memory |
| `TermuxBackend.runScript` (RUN_COMMAND + PendingIntent result), dynamic receiver, SAF folder picker, settings/Termux launch intents | UNVERIFIED - DEVICE TEST REQUIRED | compiles against stubs only |
| Gradle build / APK | NOT DONE | this repository is a Sketchware layout: it has no Gradle files or manifest, and no Android SDK exists here |
