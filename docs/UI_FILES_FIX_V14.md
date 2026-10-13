# UI and Files Workspace Fix v14

- Settings panels and workspace controls now wrap on narrow Android screens and long paths wrap instead of widening the page.
- WebView zoom controls are explicitly disabled; the viewport prevents user scaling.
- Files shows the effective OpenCode chat directory, warns when it differs from the selected project, and offers a safe alignment action.
- Files has a refresh action and an Expand all folders action (bounded to 400 folders / 8 levels to avoid runaway traversal).

Device testing is still required. The file tree remains rooted in the selected Termux project; if a custom workspace is selected, the UI warns and lets the user align OpenCode to the selected project before using the Files editor.
