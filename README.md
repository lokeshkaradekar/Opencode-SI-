<div align="center">

# OpenCode SI

### AI-assisted coding on Android

**OpenCode SI is an Android application project that provides a mobile WebView interface for the OpenCode coding agent, with native Java integration and a Termux-based local runtime.**

![Android](https://img.shields.io/badge/Platform-Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)
![Sketchware Pro](https://img.shields.io/badge/Workflow-Sketchware%20Pro-5C6BC0?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Prototype-orange?style=for-the-badge)

</div>

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Setup and Sketchware workflow](#setup-and-sketchware-workflow)
- [Included APK](#included-apk)
- [Validation and limitations](#validation-and-limitations)
- [Documentation](#documentation)
- [Security and privacy](#security-and-privacy)
- [Project independence](#project-independence)
- [License](#license)

## Overview

OpenCode SI is designed to make an OpenCode coding-agent workflow accessible from an Android device. The interface runs in a WebView and communicates with native Java code. Termux provides the local command-line environment and supporting services, including the OpenCode server and Python daemon.

The project is intended for development and testing. A feature being present in the source does not mean it has been verified on every device or is fully configured in every Sketchware build.

## Features

The included source and documentation describe these areas:

- **AI coding sessions:** interact with the OpenCode agent and use Build/Plan controls where supported by the active OpenCode configuration.
- **Project workspace:** select a workspace and browse project files.
- **File operations:** supported operations include listing, reading, writing, creating, renaming, searching and deleting files through the daemon interface.
- **Terminal:** run commands and view output through the terminal integration.
- **Git:** inspect repository status, diffs, history and branches, and use supported Git actions.
- **Snapshots and recovery:** use snapshot/undo-related flows where implemented and available.
- **Health and diagnostics:** inspect service status and troubleshoot local runtime setup.
- **Themes and settings:** configure supported interface preferences.
- **Task activity and recovery:** source includes task-status, progress and continuation-related handling; actual behavior depends on the installed runtime and OpenCode responses.
- **Light-theme readability:** the package includes a note describing a global light-theme text-contrast change in `READ-ME-FIRST/LIGHT-THEME-TEXT-FIX.md`.

These are source-level capabilities, not a guarantee that every feature works in all environments.

## Architecture

```text
OpenCode SI Android interface
            |
            v
      Android WebView
            |
            v
   Native Java bridge
      |           |
      v           v
OpenCode client  Termux integration
                      |
                      v
              Python daemon
                      |
          Files / Terminal / Git /
             Snapshots / Health
```

The APK should not be assumed to contain the complete Termux or OpenCode runtime. Follow the setup documentation for the local runtime.

## Repository layout

This archive uses the `OpenCode-SI/` directory as its top-level folder.

| Path | Purpose |
|---|---|
| `Assets-Manager/` | Web assets, HTML, CSS, JavaScript and asset-side Java source copies for the documented Sketchware import layout |
| `Java-Kotlin-Manager/` | Java source files intended for the Sketchware Pro Java/Kotlin Manager |
| `Termux-Runtime/` | Bundled daemon/runtime archive for the Termux setup workflow |
| `Full-Updated-Source/docs/` | Project documentation, setup notes, status reports and recovery notes |
| `READ-ME-FIRST/` | Package notes, Sketchware layout guidance and light-theme change notes |
| `Opencode si .apk` | APK included in this archive |
| `README.md` | Project overview |

Keep the existing folder names when following the package's Sketchware instructions. This archive is a source/import package, not an original Sketchware `.swb` project export.

## Requirements

- An Android device.
- Termux from a trusted distribution source, such as the official Termux GitHub releases or F-Droid.
- Sketchware Pro for the documented source-import/build workflow.
- An ARM64 device for the documented OpenCode Termux binary.
- Network access for package installation and any configured model/provider that requires internet access.

The project's documentation recommends Android 8.0 or newer, but compatibility has not been systematically verified across Android versions and devices.

## Setup and Sketchware workflow

1. Download this repository or the ZIP package.
2. Extract it and read `READ-ME-FIRST/README-SKETCHWARE-LAYOUT.md`.
3. Review `Full-Updated-Source/docs/SKETCHWARE_SETUP.md` and `Full-Updated-Source/docs/INSTALLATION.md`.
4. Import the files into the corresponding Sketchware Pro managers using the documented folder layout.
5. Configure Termux and the local runtime according to the installation guide.
6. Build and install through your existing Sketchware Pro workflow.
7. Test the app on your device, including server health, workspace selection, chat, terminal, Git and theme contrast.

**Do not skip the setup notes.** In particular, the source includes `TaskNotificationService.java`, but its documentation states that the service must be registered in the generated Android manifest before Android can start it. Do not assume notification service support is ready merely because the Java file is present.

## Included APK

The archive contains `Opencode si .apk` (approximately 651 KiB). It is included as a convenience file in the source package; its build provenance, internal version, signing details and installation behavior have not been independently verified as part of this README review.

This is not presented as a Google Play release. Install APKs only from sources you trust and review Android's installation and permission prompts.

## Validation and limitations

- The package includes source and documentation, but this review did not run the project's complete test suites.
- No physical Android device or WebView validation was performed as part of preparing this README.
- A source archive is not proof that an APK can be rebuilt or that every feature works on-device.
- Remote Wi-Fi workspace support is described in design/status documentation; do not assume it is implemented just because those documents are included.
- The source package may include multiple copies of Java or asset files for different import locations. Follow the package notes and avoid editing only one copy unless that is intentional.

Before publishing a release, run the documented checks in the relevant source directory, verify the final Sketchware import, and test the generated APK on a real device.

## Documentation

Start with these files inside `OpenCode-SI/`:

- `READ-ME-FIRST/README-SKETCHWARE-LAYOUT.md` — where files belong in Sketchware Pro.
- `READ-ME-FIRST/MERGE_NOTES.md` — source/package assembly notes.
- `READ-ME-FIRST/LIGHT-THEME-TEXT-FIX.md` — notes on the light-theme text contrast change.
- `Full-Updated-Source/docs/README.md` — documentation index.
- `Full-Updated-Source/docs/INSTALLATION.md` — installation guidance.
- `Full-Updated-Source/docs/ANDROID_SUPPORT.md` — Android support notes.
- `Full-Updated-Source/docs/STATUS.md` — implementation status.
- `Full-Updated-Source/docs/OPENCODE.md` — OpenCode integration notes.
- `Full-Updated-Source/docs/DAEMON.md` — daemon guide.
- `Full-Updated-Source/docs/SKETCHWARE_SETUP.md` — Sketchware setup.
- `Full-Updated-Source/docs/REPAIR_NOTES.md` — troubleshooting and repair notes.
- `Full-Updated-Source/docs/ROADMAP.md` — project roadmap.
- `Full-Updated-Source/docs/REMOTE_WORKSPACE_WIFI_DESIGN.md` — remote workspace design (design documentation, not proof of a finished feature).

## Security and privacy

OpenCode SI can interact with project files and execute terminal commands through its local runtime. Use it only with workspaces and commands you trust. Review commands and file changes carefully, protect provider credentials, and do not publish secrets, tokens, local logs containing sensitive information, or personal project files in the repository.

Review the source and Android permissions before building or installing. Report security concerns privately to the project maintainer rather than posting exploitable details publicly.

## Project independence

OpenCode SI is an independent project and is not developed by, endorsed by, or affiliated with the OpenCode team. OpenCode is a separate upstream project and retains its own name, code and applicable licensing.

## License

**License information needs to be completed before this repository is published publicly.** The supplied ZIP does not contain a `LICENSE` or `LICENCE` file, and the supplied README does not state a complete license grant or its conditions. I have not invented or inferred legal terms.

Add the exact license text you intend to use as a root-level `LICENSE` file, and update this section to name it. Also check the licenses of third-party dependencies and any upstream or bundled components; this project's license does not automatically replace theirs.

---

*README prepared from the supplied OpenCode SI README and ZIP contents. It describes the package as supplied and does not claim a successful device build or end-to-end validation.*
