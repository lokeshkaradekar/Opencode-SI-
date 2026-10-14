# v24 light-theme file visibility patch

This patch is based on the supplied v23 source ZIP. It adds explicit theme-token colors
for file-tree names, row text, path display, and file controls so inherited white text
cannot disappear against light panels. It does not claim to fix the separate Termux
daemon/custom-project-path mismatch; that requires confirming the updated daemon is
installed and running on the device.

Validation: inspect the CSS diff and run the project's existing frontend/build checks.
No APK or Android device test is included.
