# OpenCode SI v42 — Manual setup alternative

The Termux external-command setup page now includes a **Manual / another way** action. It expands an easy-to-follow guide without replacing the existing automated setup path.

The guide explains how to:
1. Run `pkg update && pkg upgrade -y` in Termux.
2. Run `termux-setup-storage` and respond to any prompts.
3. Open Android Settings → Apps → Termux → Permissions and allow the available file/storage permission.
4. Force stop Termux and reopen it so Termux configuration changes take effect.
5. Check `~/storage/shared` and `~/storage/shared/Download`, create `~/storage/shared/Download/opencode-si`, and verify it.
6. If external commands are still blocked, run the existing `allow-external-apps = true` setup command.
7. Return to OpenCode SI and tap **Check again**. The app continues to rely on live checks rather than treating the manual steps as proof of success.

Each command group has a copy button. The panel is hidden until the user chooses the alternate route, keeping the first screen compact.
