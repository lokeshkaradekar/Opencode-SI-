# OpenCode SI — Wi-Fi Remote Workspace Design

Status: **design/specification, not yet an enabled runtime feature**. The current `NativeBridge.setBackend("remote")` intentionally returns `NOT_IMPLEMENTED`. Do not show a successful remote connection until the probes and all operation routing described here are implemented and tested.

## Target topology

```text
Android / Sketchware Pro APK
  WebView UI -> NativeBridge -> backend router
                              |-- LOCAL: TermuxBackend -> 127.0.0.1:8765
                              |                 -> Termux daemon + local OpenCode server
                              `-- REMOTE: RemoteWorkspaceClient -> HTTPS LAN endpoint
                                                -> remote SI-compatible daemon
                                                -> remote project + shell + Git + snapshots
```

The other computer is the workspace host. It must run a compatible OpenCode SI daemon/service and OpenCode runtime; simply sharing a folder or exposing the OpenCode UI port is not sufficient. Remote agent calls must use the remote OpenCode server, not `OpenCodeRuntime` on Android/Termux. This separation is a hard requirement for a genuine fallback.

## Pairing and authentication

1. On the host computer, launch a dedicated service bound only to the trusted Wi-Fi interface, not `0.0.0.0` by default. Generate a random pairing secret with at least 256 bits of entropy. Show it once as a QR code and a manually copyable one-time pairing code.
2. Pairing exchanges the one-time code for a revocable, device-specific bearer token. Do not reuse the Termux daemon token or an LLM provider key.
3. Store the device token only through Android `SecureStore` (Keystore AES-GCM). JavaScript may submit a new token but must never retrieve it. Never put credentials in URLs, logs, export bundles, error reports, or project metadata.
4. Require HTTPS even on Wi-Fi. Use a host certificate trusted by the Android device or pin the host certificate/public key during pairing. Reject redirects, certificate errors, hostname mismatch, and plain HTTP. Do not add a global cleartext-traffic exception to make this work.
5. Bind the host to the selected LAN interface; recommend router client isolation / firewall rules and a private trusted network. Do not port-forward this service to the public internet.
6. Provide “Forget remote host” to revoke the token locally and, where reachable, remotely. A host can revoke individual device tokens.

## Endpoint contract

Use a versioned base URL such as `https://computer-name.local:<port>/si/v1`. Never accept arbitrary paths from the UI. The native client owns an allowlist mapping the existing daemon operations to fixed relative routes. Require a JSON envelope and validate response sizes, status codes, content types, and schema before returning data to WebView.

Pairing / health endpoints:

- `GET /si/v1/ping` — unauthenticated minimal discovery only; returns service name, protocol version and a fresh nonce, no file or system details.
- `POST /si/v1/pair` — consumes a one-time code and returns a scoped device token; rate-limit and expire pairing codes.
- `GET /si/v1/health` — authenticated readiness probe returning protocol compatibility, auth validity, OpenCode readiness, workspace access, Git availability and server version. No secrets or environment dumps.
- `POST /si/v1/device/revoke` — revoke current device token.

All workspace, terminal, Git, snapshots and agent routes require the device token and project-scoped authorization. Commands must use the same policy/confirmation checks as local execution; never add a generic unrestricted shell endpoint. Use request IDs and idempotency keys for mutations to avoid duplicate commits/writes after retries.

## Health and fallback state machine

States: `LOCAL_READY`, `LOCAL_DEGRADED`, `REMOTE_UNPAIRED`, `REMOTE_PROBING`, `REMOTE_READY`, `REMOTE_DEGRADED`, `SWITCHING`, `OFFLINE`.

1. Health probes check (a) transport/TLS, (b) authentication, (c) protocol version, (d) remote OpenCode readiness, (e) selected project exists and is writable, and (f) Git/terminal capability. A TCP connection or `/ping` alone is not “healthy”.
2. Local repair remains first choice. When local checks still fail, offer “Connect to Wi-Fi computer”; never silently switch hosts or upload a local project.
3. Before switching, show the target hostname, project mapping and whether the project already exists remotely. If absent, offer explicit clone/copy/import; show source and destination and require confirmation. Do not claim the same project is available unless a stable project identity/content check confirms it.
4. Pause new mutations while switching. Allow active tasks to finish or offer Cancel; persist the last confirmed task/session ID and show whether a task may still be running. Do not replay a write/commit blindly.
5. On remote loss, keep the UI responsive and preserve the transcript. Retry bounded health probes with backoff; mark remote operations unavailable instead of routing them to local accidentally.
6. “Switch back to Termux” is an explicit action. Probe local Termux/OpenCode and project identity first. If the local project is stale, show the divergence and offer fetch/sync/backup; never overwrite either copy automatically. Then switch backend, re-open the matching local project, and verify health.
7. Record transitions in the local bounded audit log, excluding tokens, prompts, command strings, file contents and private LAN details beyond a user-visible host label.

## Timeouts and retries

Use separate connect/read timeouts and cancellation. Suggested initial values: connect 3 s, health read 5 s, ordinary API read 30 s, streaming task idle timeout 60 s with heartbeat, overall task timeout controlled by task policy rather than a fixed five-minute UI timer. Retry only idempotent reads automatically. Mutations require an idempotency key or user-visible reconciliation after ambiguous timeouts.

## Sketchware Pro compatibility

No Gradle, Android Studio, dependency, or APK workflow change is required. Keep the existing native Java files in `Java-Kotlin-Manager/`, web assets in `Assets-Manager/`, and daemon/runtime material in their existing import folders. Implement TLS and HTTP with Android platform classes already used by `TermuxBackend`; avoid third-party libraries. Any new Java file must be added to the Sketchware Java/Kotlin Manager and the full source tree, and any new JS file must be included in `app/index.html` in dependency order.

## Acceptance gates before enabling the button

- Correct pairing, expired/reused code rejection, wrong token, revoked token and certificate mismatch tests.
- Host on same Wi-Fi; host offline; Wi-Fi changes; Android screen-off/resume; remote service restart.
- Read/list/write/Git/snapshot and long-running agent task routed to the host, with no requests reaching Termux while remote is selected.
- No duplicate mutation after lost response; cancellation and progress survive WebView recreation.
- Local-to-remote and remote-to-local project mismatch/divergence handling.
- Secret scan of logs/export bundles; Android physical-device test on the existing Sketchware Pro APK workflow.

Until these gates pass, remote fallback remains explicitly unavailable. A UI toggle alone is not a remote backend.
