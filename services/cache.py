"""A tiny LRU of parsed dumps, keyed by path plus mtime and size.

Parsing is the expensive part of every request, so the result is kept until the
file changes on disk or the entry is evicted. Access is guarded by a lock so two
concurrent requests for the same file parse it only once.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path

from config import CACHE_SIZE
from services import parser, storage
from services.parser import Dump

_lock = threading.Lock()
_entries: "OrderedDict[tuple[str, int, int], Dump]" = OrderedDict()


def load(path: Path) -> Dump:
    """Return the parsed dump for ``path``, parsing it only when needed."""
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)

    with _lock:
        cached = _entries.get(key)
        if cached is not None:
            _entries.move_to_end(key)
            return cached

    dump = parser.parse(storage.read_text(path))

    with _lock:
        _entries[key] = dump
        _entries.move_to_end(key)
        while len(_entries) > max(1, CACHE_SIZE):
            _entries.popitem(last=False)
    return dump


def invalidate(path: Path) -> None:
    """Drop any cached parse of ``path`` (used after upload or delete)."""
    target = str(path)
    with _lock:
        for key in [k for k in _entries if k[0] == target]:
            del _entries[key]
