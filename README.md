# SQL Dump Viewbench

Browse and visualise SQL dump files without importing them into a database.
Drop in a `.sql` dump and get the table list, the actual rows, and an
interactive entity-relationship diagram — parsed on the fly.

## Two ways to open a dump

**Local (default).** Drop a file on the sidebar and it is opened *in place* — it
never leaves your machine and is never uploaded. A Web Worker makes one pass to
find where every statement lives, then reads only the bytes behind the rows on
screen. Table names appear while that pass is still running, so you can start
browsing immediately.

Measured on a 2 GB / 19.9M-row dump: first table listed in **0.37 s**, first page
of rows **0.23 s** after clicking, whole file indexed in **8.9 s**, jump to page
398,000 in **0.48 s**, main-thread heap **2.9 MB**.

**Server.** Dumps placed in `sql/` (or uploaded through the sidebar link) are
parsed by FastAPI instead. Better for small shared dumps, since nothing has to
travel to the browser.

Both feed the same table browser, data grid, structure view and diagram.

## Features

- **Zero-database parser** — reads `CREATE TABLE`, `INSERT`, and `ALTER TABLE`
  statements straight from the file. Works with mysqldump, pg_dump and SQLite
  output, including backtick/quoted identifiers, multi-row inserts, explicit
  column lists, and escaped strings.
- **Data grid** — server-paginated rows with primary/foreign key markers, a
  full-table substring search, and adjustable page sizes.
- **Interactive ERD** — a custom SVG diagram with pan, zoom, draggable tables,
  neighbour highlighting, focus search, and self-reference loops. No charting
  library, no CDN.
- **Structure view** — columns with types, nullability and defaults, plus what a
  table references and what references it.
- **Fast on big dumps** — one indexing pass per file, then every page is a slice.
  A 45 MB / 500k-row dump parses in a few seconds and pages in ~30 ms after that,
  including the last page.

## Running locally

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Then open <http://localhost:8000>. `sql/sample.sql` is included to try it out.

## Layout

```
app.py              FastAPI app: routers, static files, HTML template
config.py           Settings, all overridable by environment variable
routers/files.py    List, upload and delete server-side dumps
routers/tables.py   Schema and paginated table data
services/parser.py  SQL parser and row indexer (server side)
services/storage.py Safe path handling and file IO
services/cache.py   LRU of parsed dumps, keyed by path + mtime + size
templates/          Jinja2 page rendered by FastAPI
static/app.js       UI: table browser, data grid, structure view, ERD
static/sources.js   One interface over the server API and the local worker
static/worker.js    Local-file indexer: TOC pass, lazy paging, counting, search
tests/              Fixtures plus a parser-parity harness
sql/                Server-side dump storage
```

Both parsers implement the same grammar, so `tests/` keeps them honest:

```bash
python tests/parity.py > py.json     # Python parser over every fixture
node   tests/parity.js > js.json     # browser worker over the same fixtures
python tests/parity_check.py py.json js.json
```

The JS side needs the app running and `playwright-core` available.

## Configuration

| Variable        | Default    | Purpose                                        |
| --------------- | ---------- | ---------------------------------------------- |
| `SQL_DIR`       | `./sql`    | Where dumps are stored                         |
| `MAX_UPLOAD_MB` | `256`      | Upload size limit                              |
| `CACHE_SIZE`    | `2`        | Parsed dumps kept in memory (each holds the file text) |

## API

| Method   | Path                                       | Description                    |
| -------- | ------------------------------------------ | ------------------------------ |
| `GET`    | `/api/files`                               | List stored dumps              |
| `POST`   | `/api/files/upload`                        | Upload a dump                  |
| `DELETE` | `/api/files/{filename}`                    | Delete a dump                  |
| `GET`    | `/api/files/{filename}/schema`             | Tables, keys, counts, relations |
| `GET`    | `/api/files/{filename}/tables/{table}`     | Rows — `page`, `page_size`, `q` |

Interactive API docs are at `/api/docs`.

## Notes

- Parsing is textual, so it never executes any SQL in the dump.
- Local files are read through `Blob.slice`, so memory stays flat no matter how
  large the dump is; only the current page is decoded.
- A local file's exact row count is only known once that table has been walked,
  which happens in the background when you open it. Until then the app shows the
  data size rather than a number it has not counted.
- Row search over a local file scans that table's data once and is cancellable;
  results are capped at 20,000 matches.
- The index lives in the tab. Reopening the same file re-scans it — persisting it
  to IndexedDB is the obvious next step.
- Uploads are restricted to `.sql`, `.txt` and `.dump`, and filenames are
  validated against path traversal.
- Dumps are cached in memory by file mtime and size; editing a file on disk
  re-parses it on the next request.
- On hosts with an ephemeral filesystem (Render's free plan, for example),
  uploaded dumps disappear on redeploy. Attach a persistent disk and point
  `SQL_DIR` at it to keep them.



upload the sql file of any size and it provide the tables and you can visualize those tables and relation betweem them and damn those are beautiful.