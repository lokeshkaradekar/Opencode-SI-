# OpenCode download HTTP 404 fix (v41)

The v40 source script had the corrected release tag, but the APK consumes `app/setup/daemon-bundle.tar.gz`. That embedded archive still contained the old URL (`v1.18.33`), so rebuilding the APK from v40 could still run the failing URL.

v41 rebuilds `app/setup/daemon-bundle.tar.gz` from the corrected `daemon/` directory and adds a regression test that checks both the source installer and the embedded installer. Both must use `v1.18.33-termux`.

After importing v41, copy the full `app/` asset tree into Sketchware and rebuild/reinstall the APK. The device should then transfer the corrected bundle to Termux. This source-level fix has not been physically tested on an Android device.
