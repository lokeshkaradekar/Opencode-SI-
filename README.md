<div align="center">

![OpenCode — The open source AI coding agent](assets/branding/opencode-banner.png)

</div>

<div align="center">

# OpenCode SI

<div align="center">

<img src="assets/branding/opencode-logo.png" alt="OpenCode SI logo" width="180">

**An Android interface for running an AI coding agent on your phone.**

Browse project files, chat with the OpenCode agent, use a terminal, inspect Git changes, and monitor the local development environment—with execution handled through Termux.

[Features](#features) · [Screenshots](#screenshots) · [Installation](#installation) · [Device support](#requirements-and-device-support) · [Documentation index](docs/README.md) · [Roadmap](docs/ROADMAP.md) · [Troubleshooting](#troubleshooting)

</div>

> **Project status:** active prototype. The daemon and frontend have automated tests, but the Android/Sketchware integration and several real-device flows still require broader device validation. This repository does not currently contain a ready-to-install APK or a Gradle project.

## What is OpenCode SI?

OpenCode SI is a mobile interface around the OpenCode coding agent. Its Android UI is a WebView application connected to native Java bridge code. Termux provides the local command-line environment and runs the OpenCode server. The app communicates with local services over loopback rather than bundling a Linux shell inside the APK.

It is intended for developers who want to inspect and work on code projects directly from an Android device, without pretending that every desktop workflow is already supported.

> **Independence notice:** OpenCode SI is an independent community project. It is not developed by, endorsed by, or affiliated with the OpenCode team. OpenCode is a separate upstream project; this repository provides an Android-facing interface and Termux integration.

## Project facts

| Item | Current, documented state |
|---|---|
| App approach | Android WebView UI with native Java bridge |
| Local runtime | Termux, OpenCode server, and a Python daemon |
| Android build path | Sketchware Pro source import; not a Gradle/Android Studio project |
| Ready-to-install APK | Not included or verified in this repository |
| Android compatibility | ARM64 is required for the documented OpenCode Termux binary; broader device support is not certified |
| License | Not yet selected; see the note at the end of this README |

## Features

- **AI coding interface:** start and continue OpenCode sessions, with Build and Plan modes where the installed OpenCode configuration supports them.
- **Project workspace:** choose a workspace and browse project files through the app's bridge.
- **Terminal:** run commands through a persistent pseudo-terminal, stream output, send input, and cancel supported running commands.
- **File operations:** list, read, write, create, rename, search, and delete files through the daemon API.
- **Git tools:** inspect status, diffs, history, branches, and supported Git operations.
- **Snapshots and undo:** create safety snapshots and restore a prior project state where the relevant flow is available.
- **Setup and diagnostics:** inspect Termux/server health, review setup errors, and use manual setup instructions when automatic setup fails.
- **Local Termux integration:** use Termux to host the daemon and OpenCode server.
- **Theme and settings:** configure supported UI appearance and workspace options.

**Availability note:** a feature being present in source does not mean every Android integration path has been verified. See [implementation status](docs/STATUS.md) for tested, partial, and unverified components.

## Screenshots

These are screenshots captured from the app during development. They are included as real project evidence, not mockups.

| Workspace and OpenCode status | Settings and workspace selection |
|---|---|
| ![OpenCode workspace and server status](assets/screenshots/terminal.jpg) | ![OpenCode SI settings](assets/screenshots/project-workspace.jpg) |

| Setup assistance | Settings and connection controls |
|---|---|
| ![Termux setup assistance on Android](assets/screenshots/setup-help.jpg) | ![OpenCode SI settings](assets/screenshots/settings.jpg) |

### Short visual preview

![OpenCode SI screenshot tour](assets/demo/screenshot-tour.gif)

This GIF is a short **screenshot tour**, not a screen recording or a claim that these flows work end-to-end on every device. A live demo recording can be added after a reproducible, device-tested walkthrough is captured.

## Architecture

```text
Android WebView UI (app/index.html, app/js, app/css)
                 │
                 ▼
      Native Java bridge (app/java)
                 │
                 ├── OpenCode server client ── HTTP loopback ── OpenCode in Termux
                 │
                 └── Termux command integration
                              │
                              ▼
                    Python daemon (daemon/)
                    filesystem · PTY · Git · snapshots · health
```

- `app/` — WebView frontend, styles, Java bridge, and setup bundle.
- `daemon/` — Python daemon and Termux setup script.
- `tests/` — frontend, daemon, and Java logic regression tests.
- `docs/` — setup instructions, architecture notes, implementation status, and repair notes.
- `tools/` — asset validation scripts.

## Requirements and device support

### Intended environment

- Android **8.0 (API 26) or newer is recommended**. The Sketchware guide currently specifies min SDK 23; actual device compatibility has not been certified across this range.
- ARM64 Android device for the documented OpenCode Termux binary.
- **Termux from F-Droid or the official GitHub releases**. Avoid outdated Play Store builds.
- Sketchware Pro for the documented APK build/import path; the repository is not a standalone Android Studio/Gradle project.
- Internet access during package installation and when using a remote AI model provider.
- Sufficient free storage for Termux packages, OpenCode, and project files.

### What has actually been exercised?

| Environment | Evidence / status |
|---|---|
| Linux test environment | Daemon and scripted integration tests run here. |
| Android 15, ARM64, Termux 0.119.0-beta.3 | Seen in user-provided setup screenshots; this is not a full certification of all features. |
| Other Android versions, OEMs, and Termux versions | **Not yet validated systematically.** |
| Sketchware Pro APK build and full app flow | **Requires real-device validation; not verified by the automated test environment.** |
| Real model providers | Some logic is tested against scripted servers; live provider compatibility depends on configuration and network access. |

See [Android support notes](docs/ANDROID_SUPPORT.md) and [implementation status](docs/STATUS.md) for the limitations.

## Installation

The supported documented route is to import the source into Sketchware Pro and let the app set up Termux. This project does **not** currently provide a verified release APK.

1. Read the complete [installation and Sketchware build guide](docs/INSTALLATION.md).
2. Use [the detailed Sketchware setup notes](docs/SKETCHWARE_SETUP.md) to import Java files, copy assets, and configure the manifest.
3. Install and open Termux, then follow the app's setup checks. Grant Android permissions when prompted.
4. If automatic setup fails, open **Manual / another way** on the setup page and follow the copyable commands.
5. After setup, use **Check again** and confirm the actual health checks pass before relying on the agent.

Quick source checks (Linux/macOS with Python and Node installed):

```bash
npm test
npm run build
```

`npm test` runs the daemon, frontend, and Java logic test suites. The Java tests compile against test stubs; they are **not** a substitute for compiling against the Android SDK or building the APK in Sketchware Pro.

## Configuration and security

- The Android UI talks to local services on loopback; the daemon is designed to bind locally and validates requests.
- Model-provider credentials and connectivity depend on your OpenCode/provider configuration.
- The terminal command allowlist is a safety rail, **not a security sandbox**.
- Do not expose the daemon port to a public network. Review [security notes](SECURITY.md) before testing or contributing.
- Use a test project and keep backups when evaluating file edits or snapshot rollback.

## Troubleshooting

| Symptom | First thing to check |
|---|---|
| Termux command launch is refused | Ensure `allow-external-apps = true` is configured in `~/.termux/termux.properties`, then fully restart Termux. |
| Storage/workspace check fails | Run `termux-setup-storage`, grant file access in Android Settings, create the configured workspace, then tap **Check again**. |
| OpenCode download returns 404 | Use the latest source bundle and inspect the installer log for the exact release URL being requested. |
| Server is unreachable | Check Termux is installed, setup finished, the app's Termux permission is granted, and diagnostics report a healthy server. |
| A feature behaves differently on your device | Include Android version, device architecture, Termux version, app build/source revision, steps, and sanitized logs in a bug report. Never post API keys or daemon tokens. |

More help: [documentation index](docs/README.md), [installation guide](docs/INSTALLATION.md), [OpenCode integration notes](docs/OPENCODE.md), and [repair notes](docs/REPAIR_NOTES.md).

## Roadmap

See [ROADMAP.md](docs/ROADMAP.md). The priorities are reproducible Android builds, end-to-end device testing, more reliable first-run setup, and clear release artifacts—not claiming unverified functionality as finished.

## Contributing

Bug reports and focused pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Keep claims in docs aligned with test evidence and clearly label anything that requires a real Android device.

## License

No license has been added to this repository yet. Until the project owner chooses and adds a license, do not assume that the code is available for reuse, redistribution, or modification under an open-source license.
