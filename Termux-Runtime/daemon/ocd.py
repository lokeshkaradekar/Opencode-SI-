#!/usr/bin/env python3
"""ocd.py - OpenCode SI execution daemon (runs inside Termux, stdlib only).

Provides, over an authenticated loopback-only HTTP/JSON API:
  * persistent PTY shell sessions (cd persists, Ctrl+C, stdin, timeouts, lifecycle)
  * pipe-mode jobs with separate stdout/stderr (tests, builds, long-running servers)
  * a project-confined filesystem API
  * real health probes

Every reply uses the bridge envelope: {success, data, error:{code,message,details}, requestId}.
Requires: python3, bash. Nothing is simulated: all state comes from real processes.
"""
import argparse
import base64
import codecs
import collections
import fcntl
import hmac
import json
import os
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ocd_policy import Policy, redact
from ocd_events import EventLog
from ocd_errors import ApiError, os_error
from ocd_workspace import NAME_RE, Workspace
from ocd_processes import Session, Job
from ocd_runtime import Daemon
from ocd_filesystem import FS
from ocd_health import health
from ocd_http import make_handler

from ocd_config import VERSION, MAX_BODY, MAX_READ_DEFAULT, MAX_READ_HARD, MAX_WRITE, ENV_RE




def load_token(args):
    tok = os.environ.pop("OC_DAEMON_TOKEN", None)
    if args.token_stdin:
        tok = sys.stdin.readline().strip()
    if not tok:
        tf = os.path.expanduser(args.token_file)
        if os.path.exists(tf):
            if os.stat(tf).st_mode & 0o077:
                os.chmod(tf, 0o600)
            tok = open(tf).read().strip()
        else:
            os.makedirs(os.path.dirname(tf), exist_ok=True)
            tok = secrets.token_urlsafe(32)
            fd = os.open(tf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(tok + "\n")
    if len(tok) < 24:
        sys.exit("token must be at least 24 characters")
    return tok


def main(argv=None):
    ap = argparse.ArgumentParser(description="OpenCode SI daemon")
    ap.add_argument("--workspace", default="~/OpenCodeProjects")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token-file", default="~/.opencode-si/daemon.token")
    ap.add_argument("--token-stdin", action="store_true")
    ap.add_argument("--io-timeout", type=float, default=30.0)
    ap.add_argument("--info-file", default="~/.opencode-si/daemon.json")
    args = ap.parse_args(argv)
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("refusing to bind to a non-loopback address (%s)" % args.host)
    d = Daemon(args.workspace, load_token(args))
    d.io_timeout = args.io_timeout
    fs = FS(d.ws)
    srv = ThreadingHTTPServer((args.host if args.host != "localhost" else "127.0.0.1", args.port), None)
    srv.daemon_threads = True
    d.port = srv.server_address[1]
    srv.RequestHandlerClass = make_handler(d, fs)
    info = os.path.expanduser(args.info_file)
    os.makedirs(os.path.dirname(info), exist_ok=True)
    fd = os.open(info, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"port": d.port, "pid": os.getpid(), "version": VERSION, "workspace": d.ws.root, "started": d.started}, f)
    print("ocd %s listening on %s:%d workspace=%s" % (VERSION, args.host, d.port, d.ws.root), flush=True)

    def stop(*_):
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        srv.serve_forever()
    finally:
        d.shutdown()
        try:
            os.unlink(info)
        except OSError:
            pass


if __name__ == "__main__":
    main()
