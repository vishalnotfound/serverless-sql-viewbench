"""Compare the Python parser and the browser worker over the same fixtures.

    python tests/parity.py > py.json
    node   tests/parity.js > js.json
    python tests/parity_check.py py.json js.json

Exits non-zero and prints every difference when the two grammars disagree.
"""

from __future__ import annotations

import json
import sys


def walk(path, left, right, out: list[str]) -> None:
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left:
                out.append(f"{path}.{key}: missing in python")
            elif key not in right:
                out.append(f"{path}.{key}: missing in js")
            else:
                walk(f"{path}.{key}", left[key], right[key], out)
        return

    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            out.append(f"{path}: length {len(left)} (python) vs {len(right)} (js)")
        for i in range(min(len(left), len(right))):
            walk(f"{path}[{i}]", left[i], right[i], out)
        return

    # Both parsers may legitimately produce int vs float for the same number.
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        if float(left) != float(right):
            out.append(f"{path}: {left!r} (python) != {right!r} (js)")
        return

    if left != right:
        out.append(f"{path}: {left!r} (python) != {right!r} (js)")


def main() -> int:
    with open(sys.argv[1], encoding="utf-8-sig") as handle:
        python_side = json.load(handle)
    with open(sys.argv[2], encoding="utf-8-sig") as handle:
        js_side = json.load(handle)

    differences: list[str] = []
    walk("", python_side, js_side, differences)

    if differences:
        print(f"{len(differences)} difference(s):")
        for line in differences[:60]:
            print("  " + line)
        if len(differences) > 60:
            print(f"  ... and {len(differences) - 60} more")
        return 1

    tables = sum(len(entry["tables"]) for entry in python_side)
    rows = sum(len(t["rows"]) for entry in python_side for t in entry["tables"])
    print(f"parity OK: {len(python_side)} files, {tables} tables, {rows} rows identical")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
