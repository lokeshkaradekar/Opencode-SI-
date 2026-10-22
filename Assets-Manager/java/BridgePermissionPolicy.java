package com.opencode.mobile;

/** Shared permission-mode rules. These modes govern SI task submission and SI-native mutating bridge actions;
 * OpenCode's own tool permissions remain authoritative for tools executed inside its server. */
final class BridgePermissionPolicy {
    static final String ASK = "ask-each-time";
    static final String PROJECT = "allow-project";
    static final String AUTO = "full-auto";
    private BridgePermissionPolicy() {}
    static boolean valid(String mode) { return ASK.equals(mode) || PROJECT.equals(mode) || AUTO.equals(mode); }
    static String normalize(String mode) { return valid(mode) ? mode : PROJECT; }
    static String label(String mode) {
        if (ASK.equals(mode)) return "Ask each time";
        if (AUTO.equals(mode)) return "Full-auto";
        return "Allow within project";
    }
}
