"""Regression coverage for the repo-local per-test timeout plugin."""
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class TestPytestTimeoutGuard(unittest.TestCase):
    def test_expired_test_prints_stack_and_fails_instead_of_hanging_suite(self):
        with tempfile.TemporaryDirectory(prefix="oc-timeout-guard-") as temp:
            slow_test = os.path.join(temp, "test_slow.py")
            with open(slow_test, "w", encoding="utf-8") as stream:
                stream.write("import time\ndef test_sleep_forever(): time.sleep(10)\n")
            env = dict(os.environ, PYTHONPATH=ROOT)
            result = subprocess.run(
                [sys.executable, "-m", "pytest", "-p", "tools.pytest_timeout_guard",
                 "-q", "--timeout=1", "-o", "faulthandler_timeout=0", slow_test],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=8,
            )
            output = result.stdout + "\n" + result.stderr
            self.assertEqual(result.returncode, 1, output)
            self.assertIn("TEST TIMEOUT:", output)
            self.assertIn("Python stack follows", output)
            self.assertIn("exceeded --timeout=1.0 seconds", output)


if __name__ == "__main__":
    unittest.main()
