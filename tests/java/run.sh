#!/usr/bin/env bash
# Compile-level check of the four Android Java files against HAND-WRITTEN stubs of the Android/org.json APIs
# (no android.jar is available here), then run the pure-Java CommandPolicy tests.
# Passing proves: valid Java 8 syntax, consistent types and cross-file references. It does NOT prove the real
# Android APIs behave as the stubs assume -> see docs/STATUS.md (UNVERIFIED - ANDROID DEVICE TEST REQUIRED).
set -e
cd "$(dirname "$0")"
JAVAC="javac"; command -v javac >/dev/null || JAVAC="java -m jdk.compiler/com.sun.tools.javac.Main"
rm -rf out && mkdir out
$JAVAC -source 8 -target 8 -Xlint:-options -d out $(find stubs -name '*.java') ../../app/java/*.java
for f in ../../app/java/*.java; do grep -q '^package com.opencode.mobile;' "$f" || { echo "wrong package in $f"; exit 1; }; done
$JAVAC -source 8 -target 8 -Xlint:-options -cp out -d out src/com/opencode/mobile/CommandPolicyTest.java src/com/opencode/mobile/ProjectMenuCompatibilityTest.java
$JAVAC -source 8 -target 8 -Xlint:-options -cp out -d out src/com/opencode/mobile/OpenCodeServerTest.java
java -cp out com.opencode.mobile.CommandPolicyTest
java -cp out com.opencode.mobile.ProjectMenuCompatibilityTest
# OpenCode lifecycle/agent tests: real sockets, real bash scripts, real processes (see the class comment for what is faked)
java -cp out com.opencode.mobile.OpenCodeServerTest | tail -n 3; [ "${PIPESTATUS[0]}" = 0 ]
echo "java: compile OK (against stubs), CommandPolicy + OpenCode lifecycle tests OK"
