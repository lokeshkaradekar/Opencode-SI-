"""Command policy and output redaction; no daemon dependencies."""
import os
import re
import shlex

# ------------------------------------------------------------------ redaction
_REDACT = [
    (re.compile(r"(://)[^/\s:@]+:[^@\s/]+@"), r"\1***:***@"),
    (re.compile(r"\b(sk-[A-Za-z0-9_-]{16,})"), "sk-***"),
    (re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,})"), "gh_***"),
    (re.compile(r"(?i)(authorization:\s*bearer\s+)\S+"), r"\1***"),
    (re.compile(r"(?i)\b((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)(?!\*)[^\s'\"&]{6,}"), r"\1***"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"), "[private key redacted]"),
]


def redact(s):
    for rx, rep in _REDACT:
        s = rx.sub(rep, s)
    return s


# ------------------------------------------------------------------ command policy
class Policy:
    """Permission model: classify a command line as ok / confirm / deny.
    This is a safety rail for accidents and for AI-proposed commands. It is NOT a sandbox:
    the shell is as powerful as the Termux user. The security boundary is auth + loopback."""
    SEG = re.compile(r"\|\||&&|;|\||&|\n")
    WRAPPERS = {"sudo", "doas", "env", "command", "nohup", "time", "exec", "nice", "xargs"}

    @staticmethod
    def assess_argv(argv):
        """Policy for a no-shell argv. Literal arguments are never re-parsed; a shell -c payload is."""
        base = os.path.basename(argv[0]) if argv else ""
        if base in ("bash", "sh", "zsh", "dash") and "-c" in argv[1:]:
            i = argv.index("-c")
            if i + 1 < len(argv):
                return Policy.assess(argv[i + 1])
        confirm, deny = [], []
        Policy._tokens(list(argv), confirm, deny)
        return {"level": "deny" if deny else ("confirm" if confirm else "ok"), "reasons": deny or confirm}

    @staticmethod
    def assess(cmd):
        confirm, deny = [], []
        if re.search(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:", cmd):
            deny.append("fork bomb")
        if re.search(r"\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b", cmd):
            confirm.append("pipes a download into a shell")
        if re.search(r">\s*/dev/(sd|mmcblk|nvme|block)", cmd):
            deny.append("writes directly to a block device")
        for seg in Policy.SEG.split(cmd):
            try:
                t = shlex.split(seg)
            except ValueError:
                t = seg.split()
            Policy._tokens(t, confirm, deny)
        return {"level": "deny" if deny else ("confirm" if confirm else "ok"), "reasons": deny or confirm}


    @staticmethod
    def _tokens(t, confirm, deny):
        while t and (t[0] in Policy.WRAPPERS or "=" in t[0] and not t[0].startswith("-")):
            t = t[1:]
        if not t:
            return
        c, a = os.path.basename(t[0]), t[1:]
        flags = [x for x in a if x.startswith("-")]
        args = [x for x in a if not x.startswith("-")]
        if c == "rm":
            rec = any(f == "--recursive" or (not f.startswith("--") and re.search(r"[rR]", f)) for f in flags)
            force = any(f == "--force" or (not f.startswith("--") and "f" in f) for f in flags)
            if rec and any(x in ("/", "/*", "~", "~/", "$HOME", "${HOME}", "/data", "/data/data") or x.rstrip("/") in ("/data/data/com.termux", "/data/data/com.termux/files") for x in args):
                deny.append("recursive delete of a system or home directory")
            elif rec or force:
                confirm.append("rm with " + ("recursive" if rec else "force") + " flag deletes data")
            else:
                confirm.append("rm deletes files")
        elif c == "git" and a:
            sub = next((x for x in a if not x.startswith("-")), "")
            rest = a[a.index(sub) + 1:] if sub in a else []
            if sub == "reset" and "--hard" in rest:
                confirm.append("git reset --hard discards uncommitted work")
            elif sub == "clean" and not any(x in ("-n", "--dry-run") for x in rest):
                confirm.append("git clean deletes untracked files")
            elif sub == "push" and any(x in ("--force", "-f", "--force-with-lease", "--delete", "-d", "--mirror") or x.startswith("+") for x in rest):
                confirm.append("force/destructive git push rewrites remote history")
            elif sub == "checkout" and ("--" in rest or "." in rest):
                confirm.append("git checkout discards local changes")
            elif sub == "restore" and "--staged" not in rest:
                confirm.append("git restore discards local changes")
            elif sub == "branch" and any(x in ("-D", "--delete", "-d") for x in rest):
                confirm.append("deletes a git branch")
            elif sub == "stash" and rest[:1] in (["drop"], ["clear"]):
                confirm.append("drops stashed work")
            elif sub in ("filter-branch", "reflog") and sub == "filter-branch":
                confirm.append("rewrites git history")
        elif c == "dd" and any(x.startswith("of=") for x in a):
            confirm.append("dd writes raw data")
        elif c.startswith("mkfs") or c in ("fdisk", "parted", "wipefs", "sfdisk", "shred"):
            deny.append("disk/partition operation")
        elif c in ("shutdown", "reboot", "halt", "poweroff"):
            confirm.append("powers off the device")
        elif c in ("chmod", "chown", "chgrp"):
            if any(f in ("-R", "--recursive") for f in flags) or any(x in ("/", "~") for x in args):
                confirm.append(c + " changes permissions/ownership recursively")
            else:
                confirm.append(c + " changes permissions/ownership")
        elif c == "kill" and any(x in ("-1", "-9") for x in a) and "-1" in a:
            confirm.append("kill -1 signals every process")
        elif c == "mv" and any(x == "/dev/null" for x in args):
            confirm.append("moves data to /dev/null")


