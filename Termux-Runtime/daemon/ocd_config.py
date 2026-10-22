"""Protocol and runtime constants shared by daemon modules."""
VERSION = "0.2.0"
MAX_BODY = 16 * 1024 * 1024
MAX_READ_DEFAULT = 1024 * 1024
MAX_READ_HARD = 8 * 1024 * 1024
MAX_WRITE = 8 * 1024 * 1024
import re
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
