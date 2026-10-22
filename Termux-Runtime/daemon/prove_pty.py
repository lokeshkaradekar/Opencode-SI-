#!/usr/bin/env python3
"""Runs the PTY milestone sequence against a real daemon and prints the real results.
Usage: python3 daemon/prove_pty.py"""
import json, os, re, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests"))
from test_daemon import Client, Term, OCD, strip_ansi

tmp = tempfile.mkdtemp(prefix="oc-proof-")
ws = os.path.join(tmp, "OpenCodeProjects")
os.makedirs(ws)
tok = "p" * 40
p = subprocess.Popen([sys.executable, OCD, "--workspace", ws, "--port", "0", "--token-file", tmp + "/t", "--info-file", tmp + "/i.json"],
                     env=dict(os.environ, OC_DAEMON_TOKEN=tok), stdout=subprocess.PIPE, text=True)
p.stdout.readline()
c = Client(json.load(open(tmp + "/i.json"))["port"], tok)
c.call("POST", "/v1/projects", {"name": "Axiom Engine"})
root = os.path.join(ws, "Axiom Engine")
os.makedirs(root + "/src")
subprocess.run("git init -q && git config user.email a@b && git config user.name n && echo x > README.md && git add -A && git commit -qm init", shell=True, cwd=root, check=True)
t = Term(c, "Axiom Engine")
print("daemon pid=%d  shell pid=%d  (workspace %s)\n" % (p.pid, t.info()["pid"], ws))
for cmd in ["pwd", "cd src", "pwd", 'echo "OPEN_CODE_REAL_TEST_1610" > REAL_TEST.txt', "cat REAL_TEST.txt", "node --version", "npm --version", "git status"]:
    end, out = t.run(cmd)
    print("$ %s\n%s[%s exit=%s  %dms  cwd=%s]\n" % (cmd, strip_ansi(out), end["status"], end["exit_code"], end["duration_ms"], end["cwd"]))
print("on disk:", open(root + "/src/REAL_TEST.txt").read().strip())
p.terminate(); p.wait(5); shutil.rmtree(tmp, ignore_errors=True)
