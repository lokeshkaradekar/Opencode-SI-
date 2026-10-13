# Android support and requirements

## Intended target

- **Recommended starting point:** Android 8.0/API 26 or newer.
- The Sketchware notes currently specify min SDK 23 because secure storage uses Android Keystore AES-GCM. This is a source-level target, not a guarantee that every Android 6/7 device works.
- **Architecture:** ARM64 for the documented `opencode-android-arm64.tar.gz` Termux release.
- **Termux:** use a current build from F-Droid or official GitHub releases; old Play Store builds may not work with setup.
- **Build environment:** Sketchware Pro with custom Java support. This is not a Gradle Android Studio project.

## Validation matrix

| Environment | Status |
|---|---|
| Linux unit/integration test environment | Used for daemon, frontend, and scripted lifecycle tests. |
| Android 15 / ARM64 / Termux 0.119.0-beta.3 | Observed in user-provided screenshots; not a complete compatibility certification. |
| Android 8–14 | Not systematically tested. |
| Other Android 15+ devices and OEM variants | Not systematically tested. |
| 32-bit ARM or x86 Android | Not supported by the documented ARM64 OpenCode asset; not validated. |
| Sketchware Pro build on physical device | Requires validation by a developer with the matching Sketchware version. |
| Long-running background tasks under OEM battery management | Device/OEM dependent; not guaranteed. |

## Android-specific considerations

- Android may stop background processes or restrict battery use. Termux and OpenCode SI may need battery-optimization exemptions on some devices.
- Shared storage requires the Termux storage setup command and Android permission approval.
- Termux external command execution must be enabled and Termux restarted before the app can invoke it.
- Android 11+ package visibility rules require the Termux package query in the manifest.
- The app's local HTTP connection should be limited to loopback (`127.0.0.1`) as documented in the Sketchware guide.

Please open an issue with device, Android version, architecture, Termux build, Sketchware version, and exact test steps if you validate a new environment.
