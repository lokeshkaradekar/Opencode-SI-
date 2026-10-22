# Roadmap

This roadmap distinguishes planned work from implemented code. Android-specific items need reproducible device evidence.

## P0 — Make installation reproducible

- [ ] Publish a single source bundle with an unambiguous version and checksum.
- [ ] Capture a successful clean install on a physical ARM64 Android device from a fresh Termux install.
- [ ] Test first-run permissions, shared storage, external command execution, package repair, and OpenCode download failure paths.
- [ ] Verify success is shown only after all required live setup checks pass.
- [ ] Document the exact Sketchware Pro version and import procedure used for a successful build.

## P1 — End-to-end Android verification

- [ ] Build and install using the documented Sketchware Pro flow.
- [ ] Test agent start/send/cancel/resume against the documented OpenCode Termux version and at least one real model provider.
- [ ] Test terminal streaming/cancellation, file operations, Git status/commit, snapshots, and undo on a disposable project.
- [ ] Test process death, screen rotation, app resume, network loss, and low-memory recovery.
- [ ] Add a regression checklist and attach sanitized logs to release candidates.

## P2 — Repository and release quality

- [x] Add a concise project README and repository map.
- [x] Add installation, Android support, and roadmap documentation.
- [x] Add real development screenshots and a clearly labelled screenshot-tour GIF.
- [ ] Record a short live demo after the end-to-end flow is device-verified.
- [ ] Add a release checklist, versioned changelog, and downloadable build artifacts only after build reproducibility is established.
- [ ] Choose and add an explicit software license.

## P3 — Product improvements

- [ ] Validate responsive UI and accessibility on small and large screens.
- [ ] Improve actionable diagnostics for common Termux permission and storage failures.
- [ ] Test provider configuration and model-list behaviour against supported OpenCode versions.
- [ ] Add automated checks for documentation links and release-bundle contents.
- [ ] Expand the tested Android/device matrix based on community reports.

## Done means

A task is done only when relevant tests pass, documentation matches implementation, and any required physical-device test has been recorded. A Linux unit test alone does not certify an Android integration.
