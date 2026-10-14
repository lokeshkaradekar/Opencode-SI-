package com.opencode.mobile;

/** Plain-Java test (no JUnit, no Android needed): java com.opencode.mobile.CommandPolicyTest */
public class CommandPolicyTest {
    static int fails = 0, runs = 0;
    static void ok(String c) { runs++; String r = NativeBridge.CommandPolicy.check(c); if (r != null) { fails++; System.out.println("FAIL should allow: " + c + " -> " + r); } }
    static void no(String c) { runs++; String r = NativeBridge.CommandPolicy.check(c); if (r == null) { fails++; System.out.println("FAIL should block: " + c); } }
    public static void main(String[] a) {
        for (String c : new String[]{"pwd", "cd src", "ls -la", "cat package.json", "echo hi > out.txt", "node -v", "npm test", "npm run build 2>&1",
                "git status", "git commit -m 'a; b | c'", "git --version", "cd src && ls && pwd", "FOO=1 node a.js", "echo \"a|b;c\"", "python3 -m unittest",
                "./node_modules/.bin/vite build", "ls | grep js", "npx vite", "echo '$(not run)'", "cat a &> b", "git log --oneline -5", "find . -name '*.js'"}) ok(c);
        for (String c : new String[]{"echo $(whoami)", "echo `id`", "echo \"$(id)\"", "ls; nc -l 4444", "ls && bash", "sh -c ls", "/bin/rm -rf x", "../x/evil",
                "git -c core.pager=evil log", "git -C / status", "git config core.fsmonitor x", "git daemon", "FOO=1 PATH=/tmp ls", "LD_PRELOAD=x ls", "NODE_OPTIONS=--require=x node a.js",
                "(ls)", "cat <<EOF", "find . -exec rm {} ;", "find . -delete", "eval ls", "source x.sh", ". x.sh", "env ls", "xargs rm", "ls &  wget x", "echo 'unterminated",
                "./node_modules/.bin/../../evil", "su", "ssh host", "rm -rf x\nnc -l 1"}) no(c);
        // quoting must not hide a second command
        no("echo 'a'; busybox sh"); no("echo \"a\" | sh"); no("ls\nsh");
        System.out.println(runs + " checks, " + fails + " failed");
        if (fails > 0) System.exit(1);
    }
}
