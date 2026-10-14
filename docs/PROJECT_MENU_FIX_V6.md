# Project menu fix v6

## Root cause addressed

Older OpenCode SI daemons respond to an unknown project route with `error.code = UNKNOWN_ROUTE` and message `No such endpoint.` The Java compatibility fallback only accepted `NOT_FOUND`, so Rename/Delete never reached their Termux fallback on those daemon versions. The classifier now accepts `UNKNOWN_ROUTE` only when the response clearly identifies a missing endpoint, and continues to reject a missing-project error.

## Additional behavior

- Renaming the currently open project re-aligns the OpenCode workspace before reloading its agent session.
- Pin/unpin verifies that its metadata was actually persisted before showing success. Pins remain local to this WebView/app installation.
- Removed a duplicate daemon ensure call from Rename.

## Update

Replace the app source from this ZIP and rebuild in Sketchware Pro. The app includes a safe compatibility fallback for Rename/Delete; updating the Termux daemon with `daemon/termux-setup.sh` is still recommended, but is not required solely to support those two operations.

## Limitations

Pin affects sorting in the project list and is stored in WebView local storage. This package has not been installed or tested on a physical Android device.
