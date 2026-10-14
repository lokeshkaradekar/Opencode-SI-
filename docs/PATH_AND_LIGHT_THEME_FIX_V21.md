# OpenCode SI v21 — path accuracy, light-theme contrast, and Termux requirement

## Changes

- New Project now shows explicit **Default (Termux)** and **Choose phone folder** actions instead of hiding the custom-location choice behind a Cancel button.
- After creation, the UI reads the path returned by the backend and compares it with the selected parent. If the backend silently creates the project elsewhere, it reports the actual path and instructs the user to update the Termux daemon rather than pretending the selected path was honoured.
- Workspace settings now explain that **Chosen folder** changes the agent's workspace only; it does not move the project. The app's Files/Git/Terminal views follow the opened project.
- Workspace controls have explicit theme-token colors and stronger WebView-safe appearance rules to keep labels and folder-path text readable in Light and the other five themes.
- Long absolute paths wrap inside chat bubbles without expanding the viewport horizontally.
- Missing Termux produces a clear local-backend requirement message. The current architecture executes the official OpenCode CLI/server and filesystem daemon inside Termux; it is not standalone without Termux.

## Important architecture limitation

A no-Termux standalone version needs a different backend: either bundle and maintain a compatible Android runtime plus OpenCode CLI/server inside the app, or connect to a separately hosted remote backend. This patch does not claim to implement either option.

## Validation

- Frontend tests: 74 passed.
- Asset check: 17 checked, 0 problems.
- Command policy tests: 55 passed.
- Project menu compatibility: 5 passed.
- OpenCode lifecycle tests: 206 passed.
- Focused daemon project test: passed.
- Physical Android/Termux testing: not performed.
