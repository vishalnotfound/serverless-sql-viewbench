"""Zero-database SQL dump parser.

Parsing is split in two phases so that large dumps stay fast:

1. ``parse`` walks the file once, collecting table definitions and recording the
   *character spans* of every row tuple found in ``INSERT`` statements. Row values
   are never materialised here, so a large dump costs one scan plus a list of int
   pairs.
2. ``read_rows`` slices and decodes only the tuples belonging to the requested
   page.

The scanners jump between interesting characters with compiled regexes rather
than looping character by character in Python, which keeps the single pass fast.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# --- statement level patterns -------------------------------------------------

_IDENT = r"(?:`[^`]+`|\"[^\"]+\"|\[[^\]]+\]|[\w$]+)"
_QUALIFIED = _IDENT + r"(?:\s*\.\s*" + _IDENT + r")*"

_CREATE_RE = re.compile(
    r"\bCREATE\s+(?:TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("
    + _QUALIFIED
    + r")\s*\(",
    re.IGNORECASE,
)
_INSERT_RE = re.compile(
    r"\bINSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)*INTO\s+("
    + _QUALIFIED
    + r")\s*(\([^()]*\))?\s*VALUES\s*",
    re.IGNORECASE,
)
_ALTER_RE = re.compile(
    r"\bALTER\s+TABLE\s+(?:ONLY\s+)?(" + _QUALIFIED + r")\s+(.*?);",
    re.IGNORECASE | re.DOTALL,
)

# --- fragment level patterns --------------------------------------------------

_FK_RE = re.compile(
    r"FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(" + _QUALIFIED + r")\s*(?:\(([^)]*)\))?",
    re.IGNORECASE,
)
_INLINE_REF_RE = re.compile(
    r"\bREFERENCES\s+(" + _QUALIFIED + r")\s*(?:\(([^)]*)\))?", re.IGNORECASE
)
_PK_RE = re.compile(r"PRIMARY\s+KEY\s*\(([^)]*)\)", re.IGNORECASE)
_UNIQUE_RE = re.compile(r"UNIQUE\s+(?:KEY|INDEX)?\s*\w*\s*\(([^)]*)\)", re.IGNORECASE)
_CONSTRAINT_RE = re.compile(r"^CONSTRAINT\s+" + _IDENT + r"\s+", re.IGNORECASE)
_NAME_RE = re.compile(r"(" + _IDENT + r")\s*(.*)$", re.DOTALL)
_TYPE_RE = re.compile(r"^([A-Za-z][\w ]*?)\s*(\([^)]*\))?(?:\s|$)")
_DEFAULT_RE = re.compile(r"\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)", re.IGNORECASE)
_ADD_PK_RE = re.compile(r"ADD\s+(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY", re.IGNORECASE)

# Keywords that start a table-level constraint rather than a column definition.
_CONSTRAINT_START = frozenset(
    [
        "primary",
        "unique",
        "key",
        "index",
        "foreign",
        "constraint",
        "check",
        "fulltext",
        "spatial",
        "exclude",
        "period",
    ]
)

_TUPLE_TOKEN = re.compile(r"[()'\";]")
_COMMA_TOKEN = re.compile(r"[,()'\"]")
_NUMBER_RE = re.compile(r"^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$")
_INDEX_SIZE_RE = re.compile(r"\s*\(\s*\d+\s*\)\s*$")
_SORT_ORDER_RE = re.compile(r"\s+(ASC|DESC)$", re.IGNORECASE)
_QUALIFIER_SPLIT_RE = re.compile(r"\.(?![^`\"\[]*[`\"\]])")


# --- data model ---------------------------------------------------------------


@dataclass
class Column:
    name: str
    type: str
    nullable: bool = True
    default: str | None = None
    is_pk: bool = False
    is_unique: bool = False
    auto_increment: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "nullable": self.nullable,
            "default": self.default,
            "is_pk": self.is_pk,
            "is_unique": self.is_unique,
            "auto_increment": self.auto_increment,
        }


@dataclass
class ForeignKey:
    columns: list[str]
    ref_table: str
    ref_columns: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "columns": self.columns,
            "ref_table": self.ref_table,
            "ref_columns": self.ref_columns,
        }


@dataclass
class Table:
    name: str
    columns: list[Column] = field(default_factory=list)
    primary_key: list[str] = field(default_factory=list)
    foreign_keys: list[ForeignKey] = field(default_factory=list)
    row_count: int = 0
    # One entry per INSERT statement: (column order or None, [(start, end), ...])
    segments: list[tuple[list[str] | None, list[tuple[int, int]]]] = field(
        default_factory=list, repr=False
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "columns": [c.to_dict() for c in self.columns],
            "primary_key": self.primary_key,
            "foreign_keys": [fk.to_dict() for fk in self.foreign_keys],
            "row_count": self.row_count,
            "column_count": len(self.columns),
        }


@dataclass
class Dump:
    tables: list[Table]
    content: str = field(repr=False, default="")

    def table(self, name: str) -> Table | None:
        lowered = name.lower()
        for table in self.tables:
            if table.name.lower() == lowered:
                return table
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "tables": [t.to_dict() for t in self.tables],
            "table_count": len(self.tables),
            "row_count": sum(t.row_count for t in self.tables),
        }


# --- low level scanners -------------------------------------------------------


def _unquote(name: str) -> str:
    """Strip backtick/quote/bracket delimiters and any schema qualifier."""
    name = name.strip()
    if "." in name:
        name = _QUALIFIER_SPLIT_RE.split(name)[-1].strip()
    if len(name) >= 2 and name[0] in "`\"[":
        name = name[1:-1]
    return name.strip()


def _split_identifiers(text: str) -> list[str]:
    names = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        part = _INDEX_SIZE_RE.sub("", part)
        part = _SORT_ORDER_RE.sub("", part)
        names.append(_unquote(part))
    return names


_STRING_TOKEN = {
    "'": re.compile(r"['\\]"),
    '"': re.compile(r"[\"\\]"),
}


def _skip_string(s: str, i: int, quote: str, end: int) -> int:
    """Return the index just past the closing quote of a string starting at ``i``.

    Jumps quote to quote with a regex instead of walking every character, which
    matters because dump files are mostly string payload.
    """
    token = _STRING_TOKEN[quote]
    while i < end:
        match = token.search(s, i, end)
        if not match:
            return end
        i = match.end()
        if match.group() == "\\":  # backslash escape (MySQL style)
            i += 1
        elif i < end and s[i] == quote:  # escaped by doubling
            i += 1
        else:
            return i
    return end


def _match_paren(s: str, i: int, end: int) -> int:
    """Given ``i`` just past an opening paren, return the index of its closer."""
    depth = 1
    while i < end:
        match = _TUPLE_TOKEN.search(s, i, end)
        if not match:
            return end
        ch = match.group()
        i = match.end()
        if ch in "'\"":
            i = _skip_string(s, i, ch, end)
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i - 1
    return end


def _split_top_level(body: str) -> list[str]:
    """Split a CREATE TABLE body on commas that are neither nested nor quoted."""
    items: list[str] = []
    start = 0
    i = 0
    depth = 0
    n = len(body)
    while i < n:
        match = _COMMA_TOKEN.search(body, i)
        if not match:
            break
        ch = match.group()
        i = match.end()
        if ch in "'\"":
            i = _skip_string(body, i, ch, n)
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0:
            items.append(body[start : i - 1])
            start = i
    items.append(body[start:])
    return [item.strip() for item in items if item.strip()]


# --- CREATE TABLE -------------------------------------------------------------


def _parse_column(item: str, table: Table) -> None:
    name_match = _NAME_RE.match(item)
    if not name_match:
        return
    name = _unquote(name_match.group(1))
    rest = name_match.group(2).strip()

    type_match = _TYPE_RE.match(rest)
    if type_match:
        col_type = type_match.group(1).strip()
        if type_match.group(2):
            col_type += type_match.group(2).replace(" ", "")
    else:
        col_type = rest.split()[0] if rest else ""

    upper = rest.upper()
    column = Column(
        name=name,
        type=col_type.upper() or "?",
        nullable="NOT NULL" not in upper,
        auto_increment="AUTO_INCREMENT" in upper or "AUTOINCREMENT" in upper,
        is_pk="PRIMARY KEY" in upper,
        is_unique="UNIQUE" in upper,
    )

    default = _DEFAULT_RE.search(rest)
    if default:
        column.default = default.group(1)

    if column.is_pk and name not in table.primary_key:
        table.primary_key.append(name)

    ref = _INLINE_REF_RE.search(rest)
    if ref:
        table.foreign_keys.append(
            ForeignKey(
                columns=[name],
                ref_table=_unquote(ref.group(1)),
                ref_columns=_split_identifiers(ref.group(2) or ""),
            )
        )

    table.columns.append(column)


def _parse_constraint(item: str, table: Table) -> None:
    item = _CONSTRAINT_RE.sub("", item).strip()
    upper = item.upper()

    foreign_key = _FK_RE.search(item)
    if foreign_key:
        table.foreign_keys.append(
            ForeignKey(
                columns=_split_identifiers(foreign_key.group(1)),
                ref_table=_unquote(foreign_key.group(2)),
                ref_columns=_split_identifiers(foreign_key.group(3) or ""),
            )
        )
        return

    if upper.startswith("PRIMARY"):
        primary = _PK_RE.search(item)
        if primary:
            for name in _split_identifiers(primary.group(1)):
                if name not in table.primary_key:
                    table.primary_key.append(name)
        return

    if upper.startswith("UNIQUE"):
        unique = _UNIQUE_RE.search(item)
        if unique:
            names = set(_split_identifiers(unique.group(1)))
            for column in table.columns:
                if column.name in names:
                    column.is_unique = True


def _parse_create(body: str, name: str) -> Table:
    table = Table(name=name)
    for item in _split_top_level(body):
        head = item.split(None, 1)[0]
        if head.strip("`\"[]").lower() in _CONSTRAINT_START:
            _parse_constraint(item, table)
        else:
            _parse_column(item, table)

    primary = set(table.primary_key)
    for column in table.columns:
        if column.name in primary:
            column.is_pk = True
    return table


# --- INSERT -------------------------------------------------------------------


def _scan_row_spans(s: str, pos: int, end: int) -> tuple[list[tuple[int, int]], int]:
    """Collect the span of every top-level tuple until the statement terminator.

    Returns the spans (excluding the surrounding parentheses) and the index just
    past the closing semicolon, so the caller can resume scanning from there.
    """
    spans: list[tuple[int, int]] = []
    i = pos
    while i < end:
        match = _TUPLE_TOKEN.search(s, i, end)
        if not match:
            return spans, end
        ch = match.group()
        i = match.end()
        if ch == ";":
            return spans, i
        if ch in "'\"":
            i = _skip_string(s, i, ch, end)
        elif ch == "(":
            close = _match_paren(s, i, end)
            spans.append((i, close))
            i = close + 1
    return spans, end


_ESCAPES = {
    "\\n": "\n",
    "\\r": "\r",
    "\\t": "\t",
    "\\0": "\0",
    "\\'": "'",
    '\\"': '"',
    "\\\\": "\\",
    "\\Z": "\x1a",
    "\\b": "\b",
}
_ESCAPE_RE = re.compile(r"\\.")


def _unescape(match: re.Match[str]) -> str:
    return _ESCAPES.get(match.group(), match.group()[1])


def _coerce(raw: str) -> Any:
    token = raw.strip()
    if not token:
        return None
    upper = token.upper()
    if upper == "NULL":
        return None
    if upper in ("TRUE", "FALSE"):
        return upper == "TRUE"
    if len(token) >= 2 and token[0] == "'" and token[-1] == "'":
        inner = token[1:-1].replace("''", "'")
        if "\\" in inner:
            inner = _ESCAPE_RE.sub(_unescape, inner)
        return inner
    if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        return token[1:-1].replace('""', '"')
    if _NUMBER_RE.match(token):
        try:
            return int(token)
        except ValueError:
            pass
        value = float(token)
        # Keep the dump's own text when float() would not round-trip it, so a
        # DECIMAL(10,2) of 49.00 is not displayed as 49.
        return value if repr(value) == token else token
    return token


def _parse_tuple(s: str) -> list[Any]:
    """Decode a single ``(...)`` payload into Python values."""
    values: list[Any] = []
    i = 0
    n = len(s)
    start = 0
    depth = 0
    while i < n:
        match = _COMMA_TOKEN.search(s, i)
        if not match:
            break
        ch = match.group()
        i = match.end()
        if ch in "'\"":
            i = _skip_string(s, i, ch, n)
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0:
            values.append(_coerce(s[start : i - 1]))
            start = i
    values.append(_coerce(s[start:]))
    return values


# --- ALTER TABLE (constraints added after the CREATE, as pg_dump does) ---------


def _apply_alters(content: str, by_name: dict[str, Table]) -> None:
    for match in _ALTER_RE.finditer(content):
        table = by_name.get(_unquote(match.group(1)).lower())
        if table is None:
            continue
        body = match.group(2)
        for foreign_key in _FK_RE.finditer(body):
            table.foreign_keys.append(
                ForeignKey(
                    columns=_split_identifiers(foreign_key.group(1)),
                    ref_table=_unquote(foreign_key.group(2)),
                    ref_columns=_split_identifiers(foreign_key.group(3) or ""),
                )
            )
        if _ADD_PK_RE.search(body):
            primary = _PK_RE.search(body)
            if primary:
                for name in _split_identifiers(primary.group(1)):
                    if name not in table.primary_key:
                        table.primary_key.append(name)
                names = set(table.primary_key)
                for column in table.columns:
                    if column.name in names:
                        column.is_pk = True


# --- public API ---------------------------------------------------------------


def parse(content: str) -> Dump:
    """Parse a dump into tables plus row-span indexes (one pass over the text)."""
    tables: list[Table] = []
    by_name: dict[str, Table] = {}
    end = len(content)

    for match in _CREATE_RE.finditer(content):
        name = _unquote(match.group(1))
        close = _match_paren(content, match.end(), end)
        table = _parse_create(content[match.end() : close], name)
        key = name.lower()
        if key in by_name:  # a redefinition wins, matching replay semantics
            tables[tables.index(by_name[key])] = table
        else:
            tables.append(table)
        by_name[key] = table

    pos = 0
    while True:
        match = _INSERT_RE.search(content, pos)
        if not match:
            break
        spans, pos = _scan_row_spans(content, match.end(), end)
        name = _unquote(match.group(1))
        table = by_name.get(name.lower())
        if table is None:
            # Data without a CREATE TABLE: synthesise a table so it stays visible.
            table = Table(name=name)
            tables.append(table)
            by_name[name.lower()] = table
        columns = _split_identifiers(match.group(2)[1:-1]) if match.group(2) else None
        if columns and not table.columns:
            table.columns = [Column(name=c, type="?") for c in columns]
        table.segments.append((columns, spans))
        table.row_count += len(spans)

    _apply_alters(content, by_name)
    return Dump(tables=tables, content=content)


def read_rows(
    dump: Dump,
    table: Table,
    offset: int,
    limit: int,
    query: str = "",
) -> tuple[list[str], list[list[Any]], int]:
    """Decode one page of rows. Only the requested tuples are parsed."""
    content = dump.content
    columns = [c.name for c in table.columns]
    needle = query.strip().lower()

    if needle:
        selected = [
            (segment_columns, span)
            for segment_columns, spans in table.segments
            for span in spans
            if needle in content[span[0] : span[1]].lower()
        ]
        total = len(selected)
        window = selected[offset : offset + limit]
    else:
        # Walk to the page by skipping whole INSERT statements, so deep pages cost
        # the same as the first one.
        total = table.row_count
        window = []
        skip = offset
        remaining = limit
        for segment_columns, spans in table.segments:
            if remaining <= 0:
                break
            if skip >= len(spans):
                skip -= len(spans)
                continue
            chunk = spans[skip : skip + remaining]
            window.extend((segment_columns, span) for span in chunk)
            remaining -= len(chunk)
            skip = 0

    rows: list[list[Any]] = []
    for segment_columns, (start, end) in window:
        values = _parse_tuple(content[start:end])
        if segment_columns and columns and segment_columns != columns:
            lookup = dict(zip(segment_columns, values))
            values = [lookup.get(name) for name in columns]
        elif columns:
            values = (values + [None] * len(columns))[: len(columns)]
        rows.append(values)

    if not columns and rows:  # data-only table: label columns positionally
        columns = ["col_%d" % (i + 1) for i in range(max(len(r) for r in rows))]
    return columns, rows, total
