# OpenCode SI v37 — automatic Termux package repair

## User-visible change
The installer now attempts to repair an interrupted Termux `dpkg` transaction before updating package indexes or installing dependencies. This specifically handles the failure where `bash.bashrc` prompts for a conffile choice but a non-interactive `RUN_COMMAND` has no stdin.

## Safety behavior
- Uses `dpkg --force-confold --configure -a` so existing configuration files are kept.
- Uses `apt-get` with `Dpkg::Options::=--force-confold` for fix-broken, update, and install operations.
- Does not delete Termux home, project files, or user configuration.
- If repair still fails, setup stops with an explicit error rather than pretending success.
- The setup screen recognizes the dpkg/bash conffile failure and offers an error-specific copy/paste command plus Open Termux and Retry setup actions.
- The updated `app/setup/daemon-bundle.tar.gz` contains the same fixed installer used by the APK; updating only the source script would not be enough.

## Manual fallback

```bash
dpkg --force-confold --configure -a && apt-get -o Dpkg::Options::=--force-confold --fix-broken install -y
```

Run this only if OpenCode SI's automatic repair fails. If a different interactive prompt or error appears, stop and inspect it rather than guessing.

## Validation
- Frontend tests: 95 passed.
- Asset/build check: 18 assets checked, 0 problems.
- Java lifecycle tests: 208 checks passed; Java compile against test stubs passed.
- Shell syntax checked with `bash -n`.
- Not tested on a physical Android/Termux device; cannot claim the phone-side package manager is repaired until installed and verified there.
