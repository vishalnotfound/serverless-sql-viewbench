"""Dump every fixture through the Python parser as JSON.

The JS worker produces the same shape via tests/parity.js; parity_check.py
compares the two so the grammars cannot drift apart unnoticed.

Usage: python tests/parity.py > out.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services import parser  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
PAGE = 100


def describe(path: Path) -> dict:
    with open(path, encoding="utf-8", errors="replace", newline="") as handle:
        dump = parser.parse(handle.read())
    tables = []
    for table in dump.tables:
        columns, rows, total = parser.read_rows(dump, table, 0, PAGE)
        tables.append(
            {
                "name": table.name,
                "columns": [
                    {
                        "name": c.name,
                        "type": c.type,
                        "nullable": c.nullable,
                        "default": c.default,
                        "is_pk": c.is_pk,
                        "is_unique": c.is_unique,
                        "auto_increment": c.auto_increment,
                    }
                    for c in table.columns
                ],
                "primary_key": table.primary_key,
                "foreign_keys": [
                    {"columns": fk.columns, "ref_table": fk.ref_table, "ref_columns": fk.ref_columns}
                    for fk in table.foreign_keys
                ],
                "row_count": total,
                "rows": rows,
            }
        )
    return {"file": path.name, "tables": tables}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # fixtures contain non-ASCII rows
    out = [describe(path) for path in sorted(FIXTURES.glob("*.sql"))]
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
