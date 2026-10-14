# OpenCode SI v40 — Fix OpenCode release download 404

## Root cause
The setup script requested `wallentx/opencode-termux` release tag `v1.18.33`, but the actual Android/Termux release tag is `v1.18.33-termux`. The asset `opencode-android-arm64.tar.gz` exists under that tag. This mismatch produces HTTP 404 before archive validation.

## Fix
Changed the download URL to:
`https://github.com/wallentx/opencode-termux/releases/download/v1.18.33-termux/opencode-android-arm64.tar.gz`

The installer still validates the archive layout and runs `opencode --version` before replacing the installed executable. The expected runtime remains the same pinned `1.18.33` version, matching the version used by the app's existing compatibility baseline.

Release asset page: https://github.com/wallentx/opencode-termux/releases/expanded_assets/v1.18.33-termux

## Validation
Source regression test checks the correct tag and rejects the old URL. This environment cannot access GitHub directly from the container, so a live download and physical Android installation were not performed here.
