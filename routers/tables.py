"""Endpoints that expose the parsed contents of a dump."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from config import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
from services import cache, parser, storage

router = APIRouter(prefix="/api/files/{filename}", tags=["tables"])


def _load(filename: str):
    try:
        path = storage.safe_path(filename)
    except storage.StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return cache.load(path)


@router.get("/schema")
def get_schema(filename: str):
    """Every table with its columns, keys and row counts, plus the FK graph."""
    dump = _load(filename)
    payload = dump.to_dict()
    payload["file"] = filename
    known = {t.name.lower() for t in dump.tables}
    payload["relations"] = [
        {
            "from_table": table.name,
            "to_table": fk.ref_table,
            "columns": fk.columns,
            "ref_columns": fk.ref_columns,
            "resolved": fk.ref_table.lower() in known,
        }
        for table in dump.tables
        for fk in table.foreign_keys
    ]
    return payload


@router.get("/tables/{table_name}")
def get_table(
    filename: str,
    table_name: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    q: str = Query("", max_length=200),
):
    """One page of rows for a table, optionally filtered by a substring."""
    dump = _load(filename)
    table = dump.table(table_name)
    if table is None:
        raise HTTPException(status_code=404, detail="Table not found")

    offset = (page - 1) * page_size
    columns, rows, total = parser.read_rows(dump, table, offset, page_size, q)
    return {
        "table": table.name,
        "columns": columns,
        "column_meta": [c.to_dict() for c in table.columns],
        "primary_key": table.primary_key,
        "foreign_keys": [fk.to_dict() for fk in table.foreign_keys],
        "rows": rows,
        "page": page,
        "page_size": page_size,
        "total_rows": total,
        "total_pages": max(1, -(-total // page_size)),
        "filtered": bool(q.strip()),
    }
