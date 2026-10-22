package com.opencode.mobile;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Shared allowlist-based command validator, separated from Android bridge dispatch. */
final class TerminalCommandPolicy {
    static final Set<String> BUILTINS = new HashSet<String>(Arrays.asList(
            "cd", "pwd", "echo", "export", "unset", "test", "[", "true", "false", ":", "clear", "printf", "read"));
    static final Set<String> ALLOWED = new HashSet<String>(Arrays.asList(
            "ls", "cat", "head", "tail", "wc", "grep", "egrep", "find", "sort", "uniq", "diff", "cmp", "touch", "mkdir",
            "cp", "mv", "rm", "rmdir", "ln", "stat", "file", "du", "df", "tree", "basename", "dirname", "realpath",
            "sleep", "which", "type", "uname", "whoami", "date", "printenv", "sed", "awk", "tr", "cut", "tee", "chmod",
            "node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pip", "pip3", "git", "tsc", "curl", "make"));
    static final Set<String> GIT_SUB = new HashSet<String>(Arrays.asList(
            "status", "diff", "log", "branch", "checkout", "commit", "pull", "push", "fetch", "stash", "add", "restore",
            "clone", "rev-parse", "init", "show", "remote", "tag", "merge", "reset", "rm", "mv", "switch"));
    static final Set<String> BLOCKED_ENV = new HashSet<String>(Arrays.asList(
            "PATH", "IFS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_COUNT"));
    private static final Pattern ASSIGN = Pattern.compile("^([A-Za-z_][A-Za-z0-9_]*)=.*$", Pattern.DOTALL);

    static String helpText() {
        List<String> all = new ArrayList<String>(ALLOWED);
        all.addAll(BUILTINS);
        java.util.Collections.sort(all);
        StringBuilder sb = new StringBuilder("Real shell in your project folder (state such as cd persists).\nAllowed commands:\n");
        for (String s : all) {
            sb.append(s).append(' ');
        }
        sb.append("\nNot allowed: $(...), `...`, ( ), <<, other programs. Risky commands (rm, reset --hard, force-push) ask for review first.\n");
        return sb.toString();
    }

    /** Returns null if the command is acceptable, otherwise a user-readable reason. */
    static String check(String cmd) {
        if (cmd == null || cmd.length() == 0) {
            return null;
        }
        if (cmd.length() > 8000) {
            return "The command is too long.";
        }
        if (cmd.indexOf('\0') >= 0) {
            return "Invalid character in command.";
        }
        List<String> segments = new ArrayList<String>();
        StringBuilder cur = new StringBuilder();
        char quote = 0;
        int n = cmd.length();
        for (int i = 0; i < n; i++) {
            char c = cmd.charAt(i);
            char next = i + 1 < n ? cmd.charAt(i + 1) : 0;
            if (quote == '\'') {
                if (c == '\'') {
                    quote = 0;
                }
                cur.append(c);
                continue;
            }
            if (quote == '"') {
                if (c == '\\' && i + 1 < n) {
                    cur.append(c).append(next);
                    i++;
                    continue;
                }
                if (c == '`' || (c == '$' && next == '(')) {
                    return "Command substitution ($(...) or backticks) is not allowed.";
                }
                if (c == '"') {
                    quote = 0;
                }
                cur.append(c);
                continue;
            }
            if (c == '\\' && i + 1 < n) {
                cur.append(c).append(next);
                i++;
                continue;
            }
            if (c == '\'' || c == '"') {
                quote = c;
                cur.append(c);
                continue;
            }
            if (c == '`' || (c == '$' && next == '(')) {
                return "Command substitution ($(...) or backticks) is not allowed.";
            }
            if (c == '(' || c == ')') {
                return "Subshells and ( ) grouping are not allowed.";
            }
            if (c == '<' && next == '<') {
                return "Here-documents are not allowed. Write the file with the editor instead.";
            }
            if (c == '\n' || c == '\r' || c == ';' || c == '|') {
                segments.add(cur.toString());
                cur.setLength(0);
                continue;
            }
            if (c == '&') {
                char prev = i > 0 ? cmd.charAt(i - 1) : 0;
                if (prev == '>' || prev == '<' || next == '>') {
                    cur.append(c);                    // 2>&1 and &> are redirections, not separators
                    continue;
                }
                segments.add(cur.toString());
                cur.setLength(0);
                continue;
            }
            cur.append(c);
        }
        if (quote != 0) {
            return "Unterminated quote.";
        }
        segments.add(cur.toString());
        for (String seg : segments) {
            String why = checkSegment(seg.trim());
            if (why != null) {
                return why;
            }
        }
        return null;
    }

    private static String checkSegment(String seg) {
        if (seg.length() == 0) {
            return null;
        }
        List<String> toks = tokenize(seg);
        int i = 0;
        while (i < toks.size()) {
            java.util.regex.Matcher m = ASSIGN.matcher(toks.get(i));
            if (!m.matches()) {
                break;
            }
            String name = m.group(1);
            if (BLOCKED_ENV.contains(name) || name.startsWith("LD_") || name.startsWith("DYLD_") || name.startsWith("GIT_CONFIG")) {
                return "Setting " + name + " is not allowed.";
            }
            i++;
        }
        if (i >= toks.size()) {
            return null;                              // only assignments
        }
        String first = toks.get(i);
        if (first.startsWith(">") || first.startsWith("<") || first.matches("^[0-9]+[<>].*")) {
            return null;                              // leading redirection, e.g. "> file"
        }
        if (first.indexOf('/') >= 0) {
            if (!first.startsWith("./node_modules/.bin/") || first.contains("..")) {
                return "Run programs by name (for example node or npm), not by path.";
            }
        } else if (!ALLOWED.contains(first) && !BUILTINS.contains(first)) {
            return "\"" + first + "\" is not on the allowed command list. Type help to see it.";
        }
        if ("git".equals(first)) {
            if (i + 1 < toks.size()) {
                String sub = toks.get(i + 1);
                if (sub.startsWith("-") && !sub.equals("--version")) {
                    return "git options before the sub-command (such as -c or -C) are not allowed.";
                }
                if (!sub.equals("--version") && !GIT_SUB.contains(sub)) {
                    return "That git command is not allowed.";
                }
            }
        }
        if ("find".equals(first)) {
            for (int k = i + 1; k < toks.size(); k++) {
                String t = toks.get(k);
                if (t.equals("-exec") || t.equals("-execdir") || t.equals("-ok") || t.equals("-okdir") || t.equals("-delete")) {
                    return "find " + t + " is not allowed. Use rm / a script instead.";
                }
            }
        }
        return null;
    }

    /** Whitespace tokenizer that honours quotes and returns tokens with the quotes removed. */
    static List<String> tokenize(String s) {
        List<String> out = new ArrayList<String>();
        StringBuilder cur = new StringBuilder();
        boolean any = false;
        char quote = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quote != 0) {
                if (c == quote) {
                    quote = 0;
                } else if (c == '\\' && quote == '"' && i + 1 < s.length()) {
                    cur.append(s.charAt(++i));
                } else {
                    cur.append(c);
                }
            } else if (c == '\'' || c == '"') {
                quote = c;
                any = true;
            } else if (c == '\\' && i + 1 < s.length()) {
                cur.append(s.charAt(++i));
                any = true;
            } else if (Character.isWhitespace(c)) {
                if (any || cur.length() > 0) {
                    out.add(cur.toString());
                    cur.setLength(0);
                    any = false;
                }
            } else {
                cur.append(c);
                any = true;
            }
        }
        if (any || cur.length() > 0) {
            out.add(cur.toString());
        }
        return out;
    }
}
