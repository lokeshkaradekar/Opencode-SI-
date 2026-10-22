# Reproducible checks and Android packaging

## Source checks

Requirements: Node.js 22+, Python 3.12+, Java 21+, `javac`, and `bash`.

```sh
node tools/check-version-consistency.js
npm test
find app/js tools tests/frontend -name '*.js' -print0 | xargs -0 -n1 node --check
```

The Java suite compiles against hand-written Android API stubs. It validates Java syntax and app lifecycle logic; it does not replace a build against the Android SDK or an install/run test on a physical device.

## APK build status

This repository does not currently contain a Gradle Android project or a fully scripted Sketchware export/build pipeline. An APK cannot honestly be described as reproducibly buildable from this source tree alone. Sketchware Pro remains the currently documented manual packaging route. Before publishing an APK, record the Sketchware/Android build-tool versions, application ID, version code, signing method, and the SHA-256 checksum; install and test the artifact on a physical Android device.

## Runtime daemon archive

`app/setup/daemon-bundle.tar.gz` is intentionally retained because `TermuxBackend` loads it as an Android asset at runtime. Rebuild it from `daemon/` whenever daemon source changes, then run `npm run build` and the bundle regression tests. It is not an independent release binary and should not be updated without verifying its contents match `daemon/`.

## Source package hygiene

Use `tools/package-source.sh` to create a source archive without generated Java test output, Python bytecode caches, APKs, or Sketchware `.swb` exports. The script writes a SHA-256 sidecar. Tagged binary releases and their checksums should be published separately when a reproducible Android build pipeline exists.
