# OpenCode SI v38 — Termux curl/OpenSSL linker recovery

## Screenshot diagnosis
The setup log shows `CANNOT LINK EXECUTABLE "curl": cannot locate symbol "SSL_set_quic_tls_early_data_enabled" referenced by .../libcurl.so`. This is a native-library ABI mismatch between the installed curl/libcurl and TLS libraries; it occurs before the OpenCode archive can be downloaded. The server and provider checks remain Unknown because setup stopped first.

## Automatic behavior
- After dependency installation, the setup script runs `curl --version` before trying to download OpenCode.
- If curl cannot load, it upgrades Termux packages non-interactively while preserving existing config files, then reinstalls `openssl`, `libcurl`, and `curl`.
- It verifies `curl --version` again before continuing.
- If repair fails, setup stops with a specific error and a copy/paste command instead of continuing to a misleading server status.
- The APK's `app/setup/daemon-bundle.tar.gz` contains the same patched installer as `daemon/termux-setup.sh`.

## Manual fallback
If the app displays `CURL_LINKER_MISMATCH`, open Termux directly and run:

```bash
apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y && apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl
curl --version
```

Do not assume this has been fixed until `curl --version` runs without a linker error and the app's live checks pass.

## Validation
Source-level regression tests verify the repair sequence and bundled installer. This is not a physical-device test; the actual Termux package state must be verified on the user's phone.
