"""Application settings, resolved from the environment with safe defaults."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SQL_DIR = Path(os.environ.get("SQL_DIR", BASE_DIR / "sql"))
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

# Upload guard rails.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "256")) * 1024 * 1024
ALLOWED_SUFFIXES = (".sql", ".txt", ".dump")

# How many parsed dumps stay resident. Each entry holds the file text plus its
# row index, so keep this small on memory constrained hosts.
CACHE_SIZE = int(os.environ.get("CACHE_SIZE", "2"))

# Row page size limits used by the table data endpoint.
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500

SQL_DIR.mkdir(parents=True, exist_ok=True)
