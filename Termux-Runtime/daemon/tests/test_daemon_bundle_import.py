"""Verify the distributable daemon archive is self-contained and importable."""
import importlib
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "app" / "setup" / "daemon-bundle.tar.gz"


def test_bundle_extracts_and_imports_ocd():
    assert BUNDLE.is_file(), "daemon bundle missing; run tools/build-daemon-bundle.sh"
    with tempfile.TemporaryDirectory() as td:
        with tarfile.open(BUNDLE, "r:gz") as archive:
            archive.extractall(td, filter="data")
        daemon_dir = Path(td) / "daemon"
        expected = ["ocd.py", "ocd_policy.py", "ocd_events.py", "ocd_errors.py", "ocd_workspace.py", "ocd_processes.py", "ocd_filesystem.py", "ocd_config.py", "ocd_health.py", "ocd_http.py", "ocd_runtime.py", "ocd_git.py", "ocd_snap.py", "ocd_detect.py", "ocd_agent.py"]
        for name in expected:
            assert (daemon_dir / name).is_file(), f"bundle missing {name}"
        env = os.environ.copy()
        env["PYTHONPATH"] = str(daemon_dir)
        result = subprocess.run(
            [sys.executable, "-c", "import ocd; assert hasattr(ocd, 'main')"],
            cwd=td, env=env, text=True, capture_output=True, timeout=10,
        )
        assert result.returncode == 0, result.stdout + result.stderr
