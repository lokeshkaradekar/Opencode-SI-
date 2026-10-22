# Documentation index

Use these documents as the current, maintained entry points. Older files named around a specific version or fix record implementation history; they are not a promise that the issue is still present or that the associated flow is verified on every device.

## Start here

| Document | Purpose |
|---|---|
| [Installation](INSTALLATION.md) | Source import, Termux setup, verification, and first-run smoke test |
| [Android support](ANDROID_SUPPORT.md) | Intended environment and what has or has not been device-tested |
| [Implementation status](STATUS.md) | Evidence-based status for daemon, Java bridge, frontend, and OpenCode integration |
| [Roadmap](ROADMAP.md) | Planned work and explicit completion criteria |
| [OpenCode integration](OPENCODE.md) | OpenCode server and agent integration notes |
| [Daemon guide](DAEMON.md) | Local daemon behaviour and API notes |
| [Sketchware setup](SKETCHWARE_SETUP.md) | Source import and Android app configuration |
| [Repair notes](REPAIR_NOTES.md) | Troubleshooting and setup-repair history |
| [Help and contact](HELP_AND_CONTACT.md) | Help and feedback flow |
| [Restart chat](RESTART_CHAT.md) | What the restart-chat action is intended to do |

## Reporting a problem

Open a GitHub issue with the supplied bug-report form. Include exact reproduction steps and sanitized diagnostics. Do not post API keys, passwords, daemon tokens, private paths, or private project files.

## Accuracy rule

Source code and tests establish what is implemented in the tested environment. Android-specific claims require device evidence. A passing Linux test is not proof that a Sketchware APK builds or that the same flow works on a physical Android device.
