# Restart Chat

The SI chat header now has a **Restart chat** action.

- Requires confirmation before clearing the current visible conversation.
- Disabled while a task is running; the adapter also enforces this guard.
- Clears the app's current session reference, visible transcript, legacy local history, and pending proposal cache.
- Preserves project files, project settings, and the task archive.
- Does not delete the old session from OpenCode's server-side history. The next message starts a new session.

This source change has frontend regression coverage. It has not been installed or tested on a physical Android device.
