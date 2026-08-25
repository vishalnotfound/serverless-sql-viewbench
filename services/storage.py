"""Dump file storage: listing, safe path resolution, upload and delete."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import ALLOWED_SUFFIXES, SQL_DIR

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class StorageError(Exception):
    """Raised when a request names a file that cannot be served."""


def safe_path(filename: str) -> Path:
    """Resolve a user supplied name inside SQL_DIR, refusing traversal."""
    name = Path(filename).name
    if name != filename or not _SAFE_NAME.match(name):
        raise StorageError("Invalid file name")
    if not name.lower().endswith(ALLOWED_SUFFIXES):
        raise StorageError("Unsupported file type")
    path = (SQL_DIR / name).resolve()
    if path.parent != SQL_DIR.resolve():
        raise StorageError("Invalid file name")
    return path


def describe(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }


def list_files() -> list[dict[str, Any]]:
    files = [
        describe(path)
        for path in SQL_DIR.iterdir()
        if path.is_file() and path.name.lower().endswith(ALLOWED_SUFFIXES)
    ]
    files.sort(key=lambda f: f["name"].lower())
    return files


def read_text(path: Path) -> str:
    if not path.is_file():
        raise StorageError("File not found")
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
        return handle.read()


def delete(path: Path) -> None:
    if not path.is_file():
        raise StorageError("File not found")
    path.unlink()
