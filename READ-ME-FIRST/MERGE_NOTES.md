# Merge notes — how this package was built

This package was assembled by comparing four previously uploaded zips by
actual file content (not filenames or chat summaries):

1. `opencode-si-phase3-permissions-cost-refactor.zip`
2. `OpenCode-SI-Updated-Sources-Sketchware-Phase4.zip`
3. `OpenCode-SI-Sketchware-Pro-Correct-Layout.zip`
4. `OpenCode-SI-Phase6-WiFi-Remote-Design-and-Reliability.zip`

## Finding: only #3 contains the modularized daemon and bridge delegates

| File | 14-module daemon? | Bridge delegates? |
|---|---|---|
| #1 (phase3-permissions-cost-refactor) | No — `ocd.py` is 1834 lines | No |
| #2 (Phase4) | No — `ocd.py` is 1834 lines | No |
| #3 (Correct-Layout) | **Yes** — `ocd.py` is 118 lines, 14 `ocd_*.py` modules present | **Yes** — `BridgeEnvironmentDelegate.java`, `BridgeProviderDelegate.java` present, `NativeBridge.java` reduced to 1112 lines |
| #4 (Phase6) | No — regressed back to 1834-line `ocd.py`, no delegates | No |

An earlier chat turn (summarizing agent work) claimed the modular split lived
in #1. That claim was never re-checked against the actual uploaded file and
was wrong. This package corrects that: it uses #3 as the verified source-code
baseline, confirmed by direct file inspection, not by trusting a transcript.

## What this package contains

- **Source code (Java, daemon Python, JS, assets):** taken entirely from
  `OpenCode-SI-Sketchware-Pro-Correct-Layout.zip` (#3), unmodified.
- **Planning/status docs:** taken from
  `OpenCode-SI-Phase6-WiFi-Remote-Design-and-Reliability.zip` (#4)'s
  `Full-Updated-Source/docs/` folder, including
  `REMOTE_WORKSPACE_WIFI_DESIGN.md` and `RELIABILITY_FEATURE_STATUS.md`.
  Nothing in these docs was edited.

No source file from #4 overwrote anything from #3. No file was modified by
hand beyond copying.

## What was NOT done

- No code changes. This is a merge of existing files only.
- No test suites were run against this merged tree in this environment.
- No Sketchware build or on-device APK test was performed.
- No Git history was created or recovered — Sketchware Pro projects do not
  use Git, so this was never applicable in the first place. Treat each zip as
  a dated snapshot, not a commit.

## Before importing into Sketchware Pro

1. Back up your current Sketchware project.
2. Re-run the three test suites against `Termux-Runtime/daemon` (or the
   equivalent `daemon/` path) to confirm nothing in this specific combination
   broke: daemon pytest, frontend JS tests, Java lifecycle tests.
3. Confirm `Assets-Manager/setup/daemon-bundle.tar.gz` (if present) matches
   the `Termux-Runtime/daemon/` source in this package — rebuild it if not.
4. Import, build a test APK, and verify startup, server connection, file
   browser, terminal, and Git before replacing your working APK.

## Going forward

To avoid this problem again: after any agent session that claims to have
modularized or refactored code, re-download and re-upload the resulting zip
immediately, and verify file contents (not just read the chat summary)
before building on it in a later session.
