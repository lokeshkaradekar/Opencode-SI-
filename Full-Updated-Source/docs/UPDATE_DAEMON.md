# Updating the Termux daemon

The app now has a compatibility fallback for Rename/Delete when an older daemon responds `No such endpoint`. Updating the daemon is still recommended to keep the components aligned.

1. Copy the updated `daemon/` folder from this ZIP to a location accessible in Termux.
2. In Termux, `cd` into that folder and run `bash termux-setup.sh`.
3. The script stops the existing OpenCode SI daemon only if its PID is confirmed to run `~/.opencode-si/ocd.py`, copies the daemon modules, and leaves the daemon stopped.
4. Reopen OpenCode SI and open a project; the app starts the daemon automatically.

You do **not** need to run this script every time you use the app. It is an installation/update step. The app-managed OpenCode server can install a restricted Plan agent when needed and restart only the server it owns. If you started OpenCode manually in Termux, the app will not kill it; you must restart it yourself to load configuration changes.
