#!/data/data/com.termux/files/usr/bin/bash
# One-time setup inside Termux. Installs only what the daemon needs and verifies each tool.
# Run from the repo's daemon/ folder:   bash termux-setup.sh
set -euo pipefail
echo "OCSI_STAGE=CHECKING_PACKAGES"
here="$(cd "$(dirname "$0")" && pwd)"
# Stop the currently running OpenCode SI daemon BEFORE replacing its source.
# Read /proc cmdline with a real NUL separator (the old escaped "\\0" form did not
# reliably match on Android, leaving the old Python process serving stale code).
echo "OCSI_STAGE=STOPPING_OLD_DAEMON"
old_pid=""
if [ -f "$HOME/.opencode-si/daemon.json" ]; then
  old_pid="$(python -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid", ""))' "$HOME/.opencode-si/daemon.json" 2>/dev/null || true)"
fi
if [ -n "$old_pid" ] && [ "$old_pid" != "$$" ] && [ -r "/proc/$old_pid/cmdline" ]; then
  old_cmd="$(tr '\000' ' ' < "/proc/$old_pid/cmdline" 2>/dev/null || true)"
  case "$old_cmd" in
    *"$HOME/.opencode-si/ocd.py"*)
      echo "Stopping old daemon PID $old_pid"
      kill -TERM "$old_pid" 2>/dev/null || true
      tries=0
      while kill -0 "$old_pid" 2>/dev/null && [ "$tries" -lt 5 ]; do
        sleep 1
        tries=$((tries + 1))
      done
      if kill -0 "$old_pid" 2>/dev/null; then
        # Re-check identity before force-stopping; never kill a reused, unrelated PID.
        check_cmd="$(tr '\000' ' ' < "/proc/$old_pid/cmdline" 2>/dev/null || true)"
        case "$check_cmd" in
          *"$HOME/.opencode-si/ocd.py"*) kill -KILL "$old_pid" 2>/dev/null || true ;;
        esac
      fi
      ;;
    *)
      echo "Recorded daemon PID is not the OpenCode SI daemon; leaving it untouched."
      ;;
  esac
fi
# Recover an interrupted dpkg transaction before any package-index/install command.
# The user's screenshot showed dpkg waiting for a bash.bashrc conffile choice, then
# failing because RUN_COMMAND has no interactive stdin. --force-confold keeps the
# existing config and avoids that prompt; never overwrite a user's bashrc.
echo "OCSI_STAGE=REPAIRING_PACKAGE_CONFIGURATION"
export DEBIAN_FRONTEND=noninteractive
if ! dpkg --force-confold --configure -a </dev/null; then
  echo "SETUP_ERROR=DPKG_CONFIGURE_FAILED: Termux package configuration is still interrupted." >&2
  echo "MANUAL_REPAIR=dpkg --force-confold --configure -a" >&2
  exit 51
fi
if ! apt-get -o Dpkg::Options::=--force-confold --fix-broken install -y </dev/null; then
  echo "SETUP_ERROR=DPKG_FIX_BROKEN_FAILED: Termux could not repair its package state." >&2
  echo "MANUAL_REPAIR=dpkg --force-confold --configure -a && apt-get -o Dpkg::Options::=--force-confold --fix-broken install -y" >&2
  exit 52
fi
echo "OCSI_STAGE=UPDATING_PACKAGE_INDEX"
apt-get -o Dpkg::Options::=--force-confold update -y
echo "OCSI_STAGE=INSTALLING_DEPENDENCIES"
apt-get -o Dpkg::Options::=--force-confold install -y python bash git nodejs curl tar
# Some Termux upgrades can leave curl/libcurl linked against a TLS symbol that the
# installed OpenSSL library does not export (for example SSL_set_quic_tls_early_data_enabled).
# Detect that ABI mismatch before attempting the OpenCode download. Repair by upgrading
# the matching Termux packages and reinstalling the TLS/curl pair, preserving conffiles.
echo "OCSI_STAGE=VERIFYING_CURL_RUNTIME"
if ! curl --version >/dev/null 2>&1; then
  echo "OCSI_STAGE=REPAIRING_CURL_RUNTIME"
  if ! apt-get -o Dpkg::Options::=--force-confold upgrade -y </dev/null; then
    echo "SETUP_ERROR=CURL_RUNTIME_UPGRADE_FAILED: Termux package upgrade failed while repairing curl/OpenSSL." >&2
    echo "MANUAL_REPAIR=apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y && apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl" >&2
    exit 53
  fi
  if ! apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl </dev/null; then
    echo "SETUP_ERROR=CURL_RUNTIME_REINSTALL_FAILED: Could not reinstall the matching OpenSSL/libcurl/curl packages." >&2
    echo "MANUAL_REPAIR=apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y && apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl" >&2
    exit 54
  fi
  hash -r
  if ! curl --version >/dev/null 2>&1; then
    echo "SETUP_ERROR=CURL_LINKER_MISMATCH: curl still cannot load its TLS libraries after package repair." >&2
    echo "MANUAL_REPAIR=apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y && apt-get -o Dpkg::Options::=--force-confold install --reinstall -y openssl libcurl curl" >&2
    exit 55
  fi
fi
mkdir -p ~/.opencode-si ~/OpenCodeProjects ~/.termux ~/.config/opencode/agents
# Provide a real, restricted Plan agent for OpenCode versions/configurations that do not ship one.
# Never overwrite a user-defined plan.md.
if [ ! -e "$HOME/.config/opencode/agents/plan.md" ]; then
  cat > "$HOME/.config/opencode/agents/plan.md" <<'OCSI_PLAN_AGENT'
---
description: Read-only planning agent for OpenCode SI
mode: primary
permission:
  edit: deny
  bash: ask
  external_directory: deny
---
You are the Plan agent in OpenCode SI. Analyze the user's request and the current project. Produce a clear, ordered plan, note risks and tests, and ask questions when requirements are ambiguous. Do not modify project files. Do not claim to have executed commands or changed files. Shell commands require explicit approval.
OCSI_PLAN_AGENT
fi
for f in ocd.py ocd_git.py ocd_snap.py ocd_detect.py ocd_agent.py; do
  [ -f "$here/$f" ] || { echo "missing $f next to this script"; exit 1; }
  install -m 700 "$here/$f" "$HOME/.opencode-si/$f"
done
# Do not let status checks mistake stale metadata for the just-installed daemon.
rm -f "$HOME/.opencode-si/daemon.json"
python -m py_compile "$HOME/.opencode-si/ocd.py" "$HOME/.opencode-si/ocd_git.py" "$HOME/.opencode-si/ocd_snap.py" "$HOME/.opencode-si/ocd_detect.py" "$HOME/.opencode-si/ocd_agent.py"
echo "Updated daemon source installed; the app will start a fresh daemon after setup."
# Allow the OpenCode SI app to start the daemon through Termux (RUN_COMMAND). Takes effect after Termux restarts.
touch ~/.termux/termux.properties
grep -q '^allow-external-apps *= *true' ~/.termux/termux.properties || echo 'allow-external-apps = true' >> ~/.termux/termux.properties
termux-reload-settings 2>/dev/null || true
# Install the pinned Android/Termux OpenCode release automatically. This is a prebuilt executable,
# not the source repository; validate it before replacing any existing working executable.
have_working_opencode=0
if command -v opencode >/dev/null 2>&1 && opencode --version >/dev/null 2>&1; then have_working_opencode=1; fi
if [ "$have_working_opencode" -ne 1 ]; then
  echo "OCSI_STAGE=DOWNLOADING_OPENCODE"
  release_url="https://github.com/wallentx/opencode-termux/releases/download/v1.18.33-termux/opencode-android-arm64.tar.gz"
  tmpdir="$(mktemp -d "$HOME/.opencode-si/opencode-install.XXXXXX")"
  cleanup() { rm -rf "$tmpdir"; }
  trap cleanup EXIT
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --progress-bar "$release_url" -o "$tmpdir/opencode.tar.gz" 2> >(tr '\r' '\n' >> "$HOME/.opencode-si/setup-download-progress.log")
  echo "OCSI_STAGE=VERIFYING_OPENCODE_ARCHIVE"
  tar -tzf "$tmpdir/opencode.tar.gz" > "$tmpdir/archive-list.txt"
  grep -qx 'opencode' "$tmpdir/archive-list.txt" || { echo "SETUP_ERROR=ARCHIVE_LAYOUT: expected a single opencode executable" >&2; exit 31; }
  tar -xzf "$tmpdir/opencode.tar.gz" -C "$tmpdir"
  [ -f "$tmpdir/opencode" ] || { echo "SETUP_ERROR=EXECUTABLE_MISSING: archive did not contain opencode" >&2; exit 32; }
  chmod 700 "$tmpdir/opencode"
  echo "OCSI_STAGE=VERIFYING_OPENCODE_EXECUTABLE"
  version="$($tmpdir/opencode --version 2>&1)" || { echo "SETUP_ERROR=EXECUTABLE_FAILED: $version" >&2; exit 33; }
  case "$version" in *1.18.33*) ;; *) echo "SETUP_ERROR=UNEXPECTED_VERSION: $version" >&2; exit 34;; esac
  install -m 700 "$tmpdir/opencode" "$PREFIX/bin/opencode.new"
  mv -f "$PREFIX/bin/opencode.new" "$PREFIX/bin/opencode"
  echo "Installed OpenCode $version"
else
  echo "OCSI_STAGE=CHECKING_EXISTING_OPENCODE"
  current="$(opencode --version 2>&1)"
  echo "Existing OpenCode: $current"
fi

echo "OCSI_STAGE=VERIFYING_TOOLS"
for t in python bash git node npm; do printf '%-8s' "$t"; command -v "$t" >/dev/null && "$t" --version 2>&1 | head -1 || { echo MISSING; exit 1; }; done
echo
if command -v opencode >/dev/null 2>&1; then printf '%-8s' opencode; opencode --version 2>&1 | head -1
else echo "opencode is NOT installed in Termux. OpenCode SI needs it for the AI tab: install OpenCode first (see docs/OPENCODE.md)."; fi
[ -d "$HOME/storage/shared" ] || echo "Shared storage is not linked yet. Run: termux-setup-storage   (needed if OpenCode works in /storage/emulated/0/...)"
echo
echo "OCSI_STAGE=COMPLETE"
echo "Installed to ~/.opencode-si. Projects live in ~/OpenCodeProjects (one folder per project)."
echo "Next: fully close and reopen Termux once (so allow-external-apps applies), then open the OpenCode SI app."
echo "Manual start (optional):  python ~/.opencode-si/ocd.py --workspace ~/OpenCodeProjects"
echo "   it prints nothing secret; the token is in ~/.opencode-si/daemon.token if you started it yourself."
