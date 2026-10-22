# Global Light Theme Text Fix

Updated `Assets-Manager/css/app.css` with a theme-scoped global contrast rule. When `data-theme="light"` is active, text across all views and controls is forced to near-black, placeholders to dark grey, and SVG icons retain their own styling. Other themes are not targeted.

## Apply
Import the updated Assets-Manager files using the existing Sketchware workflow, replacing `css/app.css`. No Gradle or Android Studio workflow change is required.

## Verification
Archive structure and CSS patch were checked locally. This is not a device/APK test; verify the Light theme in the WebView on device, especially colored buttons and status labels.
