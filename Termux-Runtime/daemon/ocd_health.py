"""Runtime health probes using real local processes and resources."""
import os
import select
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from ocd_config import VERSION

def _run(argv, timeout=8):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 126, "", str(e)


def health(d, network=True):
    checks = []

    def add(key, name, status, detail, raw=None):
        checks.append({"key": key, "name": name, "status": status, "detail": detail, "raw": raw})

    termux = "com.termux" in os.environ.get("PREFIX", "") or "TERMUX_VERSION" in os.environ
    add("termux", "Termux", "ok" if termux else "warning",
        "Termux %s" % os.environ.get("TERMUX_VERSION", "(version unknown)") if termux else "Not running inside Termux (PREFIX/TERMUX_VERSION unset)")
    android = os.path.exists("/system/build.prop") or "ANDROID_ROOT" in os.environ
    ver = ""
    if android:
        rc, out, _ = _run(["getprop", "ro.build.version.release"], 3)
        ver = out if rc == 0 else ""
    add("os", "Android", "ok" if android else "warning", ("Android " + ver) if android else "Not Android (%s)" % sys.platform)
    import platform
    m = platform.machine()
    add("arch", "Architecture", "ok" if m in ("aarch64", "arm64") else "warning", m)
    for key, name, argv in (("node", "Node", ["node", "--version"]), ("npm", "npm", ["npm", "--version"]),
                            ("python", "Python", [sys.executable, "--version"]), ("git", "Git", ["git", "--version"]),
                            ("shell", "Shell (bash)", ["bash", "--version"])):
        rc, out, err = _run(argv, 10)
        if rc == 0:
            add(key, name, "ok", (out or err).splitlines()[0])
        else:
            add(key, name, "failed", "%s is not usable" % name, "exit %s: %s" % (rc, err or "not found"))
    # real PTY probe: allocate a pty, spawn bash on it, read output back
    try:
        t0 = time.time()
        m_, s_ = os.openpty()
        p = subprocess.Popen(["bash", "-c", "echo OC_PTY_OK; test -t 0 && echo TTY_YES"], stdin=s_, stdout=s_, stderr=s_, start_new_session=True)
        os.close(s_)
        out = b""
        while time.time() - t0 < 5:
            r, _, _ = select.select([m_], [], [], 0.3)
            if r:
                try:
                    c = os.read(m_, 4096)
                except OSError:
                    break
                if not c:
                    break
                out += c
            elif p.poll() is not None:
                break
        p.wait(2)
        os.close(m_)
        ok = b"OC_PTY_OK" in out and b"TTY_YES" in out
        add("pty", "PTY", "ok" if ok else "failed", "PTY allocated, shell saw a tty" if ok else "PTY probe failed", None if ok else repr(out[:200]))
    except Exception as e:
        add("pty", "PTY", "failed", "Could not allocate a PTY", repr(e))
    try:
        probe = os.path.join(d.ws.root, ".oc-probe-%s" % uuid.uuid4().hex[:6])
        with open(probe, "w") as f:
            f.write("x")
        os.unlink(probe)
        add("workspace", "Workspace", "ok", d.ws.root)
    except OSError as e:
        add("workspace", "Workspace", "failed", "Workspace is not writable", str(e))
    sv = os.statvfs(d.ws.root)
    free = sv.f_bavail * sv.f_frsize // (1024 * 1024)
    add("storage", "Storage", "failed" if free < 200 else "ok", "%d MB free" % free, "ENOSPC risk: only %d MB free" % free if free < 200 else None)
    rc, out, err = _run(["bash", "-c", "echo OC_EXEC_OK"], 5)
    ok = rc == 0 and out == "OC_EXEC_OK"
    add("process", "Process execution", "ok" if ok else "failed",
        ("Spawned a real process; %d session(s), %d job(s) tracked" % (len(d.sessions), len(d.jobs))) if ok else "Could not run a process",
        None if ok else "exit %s: %s" % (rc, err))
    gok = False
    try:
        import tempfile as _t
        with _t.TemporaryDirectory(dir=d.ws.root, prefix=".oc-gitprobe-") as td:
            r1 = _run(["git", "init", "-q", td], 8)
            gok = r1[0] == 0 and os.path.isdir(os.path.join(td, ".git"))
    except Exception:
        gok = False
    add("git_ops", "Git repository support", "ok" if gok else "failed", "git init works in the workspace" if gok else "git cannot create a repository in the workspace")
    if network:
        try:
            s = socket.create_connection(("1.1.1.1", 443), 3)
            s.close()
            add("network", "Network", "ok", "TCP 1.1.1.1:443 reachable")
        except OSError as e:
            add("network", "Network", "failed", "No outbound network", str(e))
    st = "ok"
    for c in checks:
        if c["status"] == "failed":
            st = "failed"
            break
        if c["status"] == "warning":
            st = "warning"
    return {"status": st, "checks": checks, "daemon": VERSION}


