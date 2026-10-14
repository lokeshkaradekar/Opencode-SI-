# v35 Termux external-command recovery

The RUN_COMMAND error cannot be repaired by OpenCode SI invoking RUN_COMMAND: Termux blocks that bridge until `allow-external-apps = true` is saved and Termux is restarted. The setup screen now gives a one-time command to paste directly into the Termux app. It updates an existing key (rather than appending duplicates), prints the saved value, and does not run `termux-setup-storage` on every attempt.

After it prints `allow-external-apps = true`, force-stop Termux from Android Settings → Apps → Termux, reopen Termux, return to OpenCode SI, and tap Check again. Only run `termux-setup-storage` separately if shared-storage access itself fails.

This is a required one-time manual security step; it cannot be automated from the blocked external command bridge.
