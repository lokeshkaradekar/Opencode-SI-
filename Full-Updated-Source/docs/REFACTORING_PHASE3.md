# Phase 3 refactoring pass — 2026-10-20

This is a behavior-preserving first decomposition pass. It creates explicit module boundaries without changing the public JavaScript bridge contract or the OpenCode server lifecycle behavior.

## Changes

- `NativeBridge.CommandPolicy` remains as a compatibility facade, while the allowlist/parser implementation moved to `TerminalCommandPolicy.java`.
- OpenCode Termux shell payloads moved to `OpenCodeServerScripts.java`. `OpenCodeServer` retains named aliases so its lifecycle code and tests keep the same entry points.
- The safe Markdown-ish agent reply renderer moved from `agent.js` to `reply-renderer.js`; `index.html` loads it before `agent.js`, and the adapter calls its explicit export.
- Regression tests now inspect the extracted modules and verify script load order and key safety invariants.

## Validation

- Frontend: 145/145 passed, including the new module-boundary tests.
- Java compile and command-policy checks: compile passed; 55 policy checks and 5 project-menu checks passed.
- OpenCode lifecycle suite: 246 checks, 0 failed.
- Asset validation: 19 assets, 0 problems.
- Daemon test suite: not completed within the 120-second execution window; it emitted Python `ResourceWarning` messages and a test-server timeout diagnostic. This is not recorded as a pass.

## Still outstanding

This is not the complete large-file refactor. `NativeBridge.java`, `OpenCodeServer.java`, and `agent.js` still contain substantial responsibilities. In particular, provider/project operations in the bridge, setup diagnostics in the server manager, the chat screen UI, and prompts embedded in Java still need separately reviewed extraction work. No physical Android device run is required for this source refactor, and no device result is claimed.
