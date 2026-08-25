"""Endpoints for managing the SQL dump files on disk."""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from config import MAX_UPLOAD_BYTES
from services import cache, storage

router = APIRouter(prefix="/api/files", tags=["files"])

_CHUNK = 1024 * 1024


@router.get("")
def list_files():
    return storage.list_files()


@router.post("/upload", status_code=201)
async def upload_file(file: UploadFile = File(...)):
    try:
        path = storage.safe_path(file.filename or "")
    except storage.StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    written = 0
    try:
        with open(path, "wb") as handle:
            while chunk := await file.read(_CHUNK):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="File too large")
                handle.write(chunk)
    except HTTPException:
        path.unlink(missing_ok=True)
        raise
    except OSError as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not store file") from exc
    finally:
        cache.invalidate(path)

    return storage.describe(path)


@router.delete("/{filename}")
def delete_file(filename: str):
    try:
        path = storage.safe_path(filename)
        storage.delete(path)
    except storage.StorageError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    cache.invalidate(path)
    return {"deleted": filename}
