package com.opencode.mobile;

/** Regression tests for compatibility with older daemons that lack project Rename/Delete routes. */
public final class ProjectMenuCompatibilityTest {
    private static int checks;
    private static int failures;
    private static void check(boolean value, String label) {
        checks++;
        if (!value) { failures++; System.out.println("FAIL: " + label); }
    }
    public static void main(String[] args) {
        check(NativeBridge.isMissingProjectEndpoint(new NativeBridge.BridgeException("UNKNOWN_ROUTE", "No such endpoint.", null)), "UNKNOWN_ROUTE No such endpoint enables fallback");
        check(NativeBridge.isMissingProjectEndpoint(new NativeBridge.BridgeException("UNKNOWN_ROUTE", "Unknown route", "missing endpoint /v1/projects/rename")), "UNKNOWN_ROUTE endpoint detail enables fallback");
        check(NativeBridge.isMissingProjectEndpoint(new NativeBridge.BridgeException("NOT_FOUND", "No such endpoint.", null)), "NOT_FOUND endpoint enables fallback");
        check(!NativeBridge.isMissingProjectEndpoint(new NativeBridge.BridgeException("NOT_FOUND", "Project not found: demo", null)), "missing project must not invoke fallback");
        check(!NativeBridge.isMissingProjectEndpoint(new NativeBridge.BridgeException("PERMISSION_DENIED", "No such endpoint.", null)), "non-route errors must not invoke fallback");
        System.out.println("project-menu-compat: " + checks + " checks, " + failures + " failed");
        if (failures != 0) System.exit(1);
    }
}
