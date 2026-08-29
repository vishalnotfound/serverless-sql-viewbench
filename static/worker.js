/* SQL Dump Viewbench - indexing worker.
 *
 * Runs off the main thread and never loads the dump into memory. One "table of
 * contents" pass records where every statement lives; after that, a page costs
 * only the bytes behind the rows on screen.
 *
 * The scanner works on raw bytes. ASCII delimiters can never appear inside a
 * UTF-8 multi-byte sequence (continuation bytes are all >= 0x80), so this is
 * safe without decoding; only rows that get displayed are decoded.
 */
"use strict";

var QUOTE = 39, DQUOTE = 34, BTICK = 96, BSLASH = 92, SEMI = 59;
var DASH = 45, HASH = 35, SLASH = 47, STAR = 42, NL = 10, OPEN = 40, CLOSE = 41;

var M_CODE = 0, M_STRING = 1, M_LINE = 2, M_BLOCK = 3;

var CHUNK = 8 * 1024 * 1024;    // 8MB x4 concurrent measured fastest
var READ_AHEAD = 4;
var HEAD_LIMIT = 64 * 1024;     // bytes kept to identify a statement
var DDL_LIMIT = 1024 * 1024;    // bytes kept for CREATE / ALTER bodies
var ROW_WINDOW = 256 * 1024;    // first read when fetching a page
var MAX_WINDOW = 64 * 1024 * 1024;
var CHECKPOINT_CAP = 200000;    // per table; stride grows to stay under this
var SEARCH_CAP = 20000;         // matches collected before a search stops

var file = null;
var tables = [];
var byName = Object.create(null);
var cursors = Object.create(null);   // table -> Map(page -> position)
var searches = Object.create(null);  // table + query -> matching row spans
var cancelled = Object.create(null);

var decoder = new TextDecoder("utf-8");
var encoder = new TextEncoder();

// ---------------------------------------------------------------- utilities

function lower(value) { return String(value).toLowerCase(); }

function unquote(name) {
  name = String(name).trim();
  if (name.indexOf(".") !== -1 && !/^[`"[]/.test(name)) {
    var parts = name.split(".");
    name = parts[parts.length - 1].trim();
  }
  if (name.length >= 2 && (name[0] === "`" || name[0] === '"' || name[0] === "[")) {
    name = name.slice(1, -1);
  }
  return name.trim();
}

function splitIdentifiers(text) {
  var out = [];
  String(text).split(",").forEach(function (part) {
    part = part.trim().replace(/\s*\(\s*\d+\s*\)\s*$/, "").replace(/\s+(ASC|DESC)$/i, "");
    if (part) out.push(unquote(part));
  });
  return out;
}

function byteLength(text) { return encoder.encode(text).length; }

function readBytes(start, end) {
  return file.slice(start, end).arrayBuffer().then(function (buffer) {
    return new Uint8Array(buffer);
  });
}

// Sequential chunks with several reads in flight; concurrency measured at
// roughly 1.75x the throughput of sequential reads.
function chunkReader(start, end) {
  var pos = start;
  var queue = [];
  function push() {
    if (pos >= end) return;
    var from = pos;
    var to = Math.min(pos + CHUNK, end);
    pos = to;
    queue.push({ base: from, promise: readBytes(from, to) });
  }
  for (var i = 0; i < READ_AHEAD; i++) push();
  return function next() {
    if (!queue.length) return null;
    var item = queue.shift();
    push();
    return item.promise.then(function (bytes) {
      return { base: item.base, bytes: bytes };
    });
  };
}

// ---------------------------------------------------------------- TOC scanner

function newScanState() {
  return {
    mode: M_CODE,
    quote: 0,
    carryBackslashes: 0,
    pendingQuote: false,   // chunk ended on a possible closing quote
    pendingByte: 0,        // chunk ended on the '-' or '/' of a comment marker
    stmtStart: -1,
    pieces: null,
    captured: 0,
    limit: HEAD_LIMIT,
    from: 0,
    capturing: false,
  };
}

function beginStatement(state, offset, absolute) {
  state.stmtStart = absolute;
  state.pieces = [];
  state.captured = 0;
  state.limit = HEAD_LIMIT;
  state.from = offset;
  state.capturing = true;
}

function capture(state, bytes, upto) {
  if (!state.capturing) { state.from = upto; return; }
  var room = state.limit - state.captured;
  if (room <= 0) { state.capturing = false; state.from = upto; return; }
  var to = Math.min(upto, state.from + room);
  if (to > state.from) {
    state.pieces.push(bytes.slice(state.from, to));
    state.captured += to - state.from;
    // Once the head is known, DDL is worth keeping in full.
    if (state.pieces.length === 1 && state.limit === HEAD_LIMIT &&
        /^\s*(CREATE|ALTER)\b/i.test(decoder.decode(state.pieces[0].subarray(0, 32)))) {
      state.limit = DDL_LIMIT;
    }
  }
  state.from = upto;
}

function capturedText(state) {
  if (!state.pieces || !state.pieces.length) return "";
  if (state.pieces.length === 1) return decoder.decode(state.pieces[0]);
  var merged = new Uint8Array(state.captured);
  var at = 0;
  state.pieces.forEach(function (piece) { merged.set(piece, at); at += piece.length; });
  return decoder.decode(merged);
}

/* Walk one chunk, calling onStatement(start, semicolon, text) per statement.
 * Comments and quoted strings are honoured, so a ';' or an apostrophe inside
 * them never terminates a statement early. */
function scanChunk(bytes, base, state, onStatement) {
  var n = bytes.length;
  var i = 0;

  if (state.pendingQuote) {                    // resolve a quote left hanging
    state.pendingQuote = false;
    if (bytes[0] === state.quote) i = 1;       // doubled -> still inside
    else state.mode = M_CODE;
  }
  if (state.pendingByte) {                     // resolve a split comment marker
    var previous = state.pendingByte;
    state.pendingByte = 0;
    if (previous === DASH && bytes[0] === DASH) { state.mode = M_LINE; i = 1; }
    else if (previous === SLASH && bytes[0] === STAR) { state.mode = M_BLOCK; i = 1; }
  }
  state.from = i;

  while (i < n) {
    if (state.mode === M_STRING) {
      var q = bytes.indexOf(state.quote, i);
      if (q < 0) {
        var run = 0, tail = n - 1;
        while (tail >= 0 && bytes[tail] === BSLASH) { run++; tail--; }
        state.carryBackslashes = run;
        i = n;
        break;
      }
      if (state.quote !== BTICK) {             // backslash escapes, MySQL style
        var slashes = 0, k = q - 1;
        while (k >= 0 && bytes[k] === BSLASH) { slashes++; k--; }
        if (k < 0) slashes += state.carryBackslashes;
        if (slashes % 2 === 1) { i = q + 1; continue; }
      }
      state.carryBackslashes = 0;
      if (q + 1 < n) {
        if (bytes[q + 1] === state.quote) { i = q + 2; continue; }   // doubled
        state.mode = M_CODE;
        i = q + 1;
        continue;
      }
      state.pendingQuote = true;               // decide on the next chunk
      i = n;
      break;
    }

    if (state.mode === M_LINE) {
      var nl = bytes.indexOf(NL, i);
      if (nl < 0) { i = n; break; }
      state.mode = M_CODE;
      i = nl + 1;
      continue;
    }

    if (state.mode === M_BLOCK) {
      var star = bytes.indexOf(STAR, i);
      if (star < 0 || star + 1 >= n) { i = n; break; }
      if (bytes[star + 1] === SLASH) { state.mode = M_CODE; i = star + 2; continue; }
      i = star + 1;
      continue;
    }

    var b = bytes[i];

    // Comments are recognised before a statement can open, otherwise a comment
    // sitting above a statement becomes part of it and anchored patterns such
    // as /^\s*CREATE/ stop matching.
    if (b === DASH) {
      if (i + 1 >= n) { state.pendingByte = DASH; i = n; break; }
      if (bytes[i + 1] === DASH) { state.mode = M_LINE; i += 2; continue; }
    } else if (b === SLASH) {
      if (i + 1 >= n) { state.pendingByte = SLASH; i = n; break; }
      if (bytes[i + 1] === STAR) { state.mode = M_BLOCK; i += 2; continue; }
    } else if (b === HASH) {
      state.mode = M_LINE;
      i++;
      continue;
    }

    if (state.stmtStart < 0 && b > 32) beginStatement(state, i, base + i);

    if (b === QUOTE || b === DQUOTE || b === BTICK) {
      state.mode = M_STRING;
      state.quote = b;
      i++;
    } else if (b === SEMI) {
      capture(state, bytes, i);
      if (state.stmtStart >= 0) onStatement(state.stmtStart, base + i, capturedText(state));
      state.stmtStart = -1;
      state.capturing = false;
      state.pieces = null;
      i++;
      state.from = i;
    } else {
      i++;
    }
  }

  capture(state, bytes, n);
  state.from = 0;
}

// ---------------------------------------------------------------- DDL parsing

var IDENT = "(?:`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\]|[\\w$]+)";
var QUALIFIED = IDENT + "(?:\\s*\\.\\s*" + IDENT + ")*";
var CREATE_RE = new RegExp("^\\s*CREATE\\s+(?:TEMPORARY\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(" + QUALIFIED + ")\\s*\\(", "i");
var INSERT_RE = new RegExp("^\\s*INSERT\\s+(?:LOW_PRIORITY\\s+|DELAYED\\s+|HIGH_PRIORITY\\s+|IGNORE\\s+)*INTO\\s+(" + QUALIFIED + ")\\s*(\\([^()]*\\))?\\s*VALUES\\s*", "i");
var ALTER_RE = new RegExp("^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(" + QUALIFIED + ")\\s+", "i");
var CONSTRAINT_PREFIX = new RegExp("^CONSTRAINT\\s+" + IDENT + "\\s+", "i");
var COLUMN_HEAD = new RegExp("^(" + IDENT + ")\\s*([\\s\\S]*)$");
var CONSTRAINT_START = /^(primary|unique|key|index|foreign|constraint|check|fulltext|spatial|exclude|period)\b/i;
var PK_RE = /PRIMARY\s+KEY\s*\(([^)]*)\)/i;
var UNIQUE_RE = /UNIQUE\s+(?:KEY|INDEX)?\s*\w*\s*\(([^)]*)\)/i;
var TYPE_RE = /^([A-Za-z][\w ]*?)\s*(\([^)]*\))?(?:\s|$)/;
var DEFAULT_RE = /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i;
var ADD_PK_RE = /ADD\s+(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/i;

function foreignKeyRe() {
  return new RegExp("FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(" + QUALIFIED + ")\\s*(?:\\(([^)]*)\\))?", "ig");
}
function inlineRefRe() {
  return new RegExp("\\bREFERENCES\\s+(" + QUALIFIED + ")\\s*(?:\\(([^)]*)\\))?", "i");
}

function splitTopLevel(body) {
  var items = [];
  var depth = 0, quote = 0, start = 0;
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) {
        if (body[i + 1] === quote) i++;
        else quote = 0;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { items.push(body.slice(start, i)); start = i + 1; }
  }
  items.push(body.slice(start));
  return items.map(function (item) { return item.trim(); }).filter(Boolean);
}

function matchParen(text, from) {
  var depth = 1, quote = 0;
  for (var i = from; i < text.length; i++) {
    var c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { if (text[i + 1] === quote) i++; else quote = 0; }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (!depth) return i; }
  }
  return text.length;
}

function blankTable(name) {
  return {
    name: name,
    columns: [],
    primary_key: [],
    foreign_keys: [],
    row_count: null,
    spans: [],
    bytes: 0,
    checkpoints: null,
    stride: 0,
  };
}

function parseColumn(item, table) {
  var head = COLUMN_HEAD.exec(item);
  if (!head) return;
  var name = unquote(head[1]);
  var rest = (head[2] || "").trim();
  var typeMatch = TYPE_RE.exec(rest);
  var type = typeMatch
    ? (typeMatch[1] || "").trim() + (typeMatch[2] ? typeMatch[2].replace(/\s+/g, "") : "")
    : (rest.split(/\s+/)[0] || "");
  var upper = rest.toUpperCase();

  var column = {
    name: name,
    type: (type || "?").toUpperCase(),
    nullable: upper.indexOf("NOT NULL") === -1,
    default: null,
    is_pk: upper.indexOf("PRIMARY KEY") !== -1,
    is_unique: upper.indexOf("UNIQUE") !== -1,
    auto_increment: upper.indexOf("AUTO_INCREMENT") !== -1 || upper.indexOf("AUTOINCREMENT") !== -1,
  };
  var def = DEFAULT_RE.exec(rest);
  if (def) column.default = def[1];
  if (column.is_pk && table.primary_key.indexOf(name) === -1) table.primary_key.push(name);

  var ref = inlineRefRe().exec(rest);
  if (ref) {
    table.foreign_keys.push({
      columns: [name],
      ref_table: unquote(ref[1]),
      ref_columns: splitIdentifiers(ref[2] || ""),
    });
  }
  table.columns.push(column);
}

function parseConstraint(item, table) {
  var stripped = item.replace(CONSTRAINT_PREFIX, "").trim();
  var fkRe = foreignKeyRe();
  var fk = fkRe.exec(stripped);
  if (fk) {
    table.foreign_keys.push({
      columns: splitIdentifiers(fk[1]),
      ref_table: unquote(fk[2]),
      ref_columns: splitIdentifiers(fk[3] || ""),
    });
    return;
  }
  if (/^PRIMARY/i.test(stripped)) {
    var pk = PK_RE.exec(stripped);
    if (pk) {
      splitIdentifiers(pk[1]).forEach(function (name) {
        if (table.primary_key.indexOf(name) === -1) table.primary_key.push(name);
      });
    }
    return;
  }
  if (/^UNIQUE/i.test(stripped)) {
    var unique = UNIQUE_RE.exec(stripped);
    if (unique) {
      var names = splitIdentifiers(unique[1]);
      table.columns.forEach(function (column) {
        if (names.indexOf(column.name) !== -1) column.is_unique = true;
      });
    }
  }
}

function parseCreate(text) {
  var head = CREATE_RE.exec(text);
  if (!head) return null;
  var table = blankTable(unquote(head[1]));
  var bodyStart = head.index + head[0].length;
  var body = text.slice(bodyStart, matchParen(text, bodyStart));

  splitTopLevel(body).forEach(function (item) {
    var first = item.split(/\s+/)[0].replace(/^[`"\[]/, "");
    if (CONSTRAINT_START.test(first)) parseConstraint(item, table);
    else parseColumn(item, table);
  });

  table.columns.forEach(function (column) {
    if (table.primary_key.indexOf(column.name) !== -1) column.is_pk = true;
  });
  return table;
}

function applyAlter(text) {
  var head = ALTER_RE.exec(text);
  if (!head) return;
  var table = byName[lower(unquote(head[1]))];
  if (!table) return;
  var body = text.slice(head.index + head[0].length);

  var fkRe = foreignKeyRe();
  var fk;
  while ((fk = fkRe.exec(body))) {
    table.foreign_keys.push({
      columns: splitIdentifiers(fk[1]),
      ref_table: unquote(fk[2]),
      ref_columns: splitIdentifiers(fk[3] || ""),
    });
  }
  if (ADD_PK_RE.test(body)) {
    var pk = PK_RE.exec(body);
    if (pk) {
      splitIdentifiers(pk[1]).forEach(function (name) {
        if (table.primary_key.indexOf(name) === -1) table.primary_key.push(name);
      });
      table.columns.forEach(function (column) {
        if (table.primary_key.indexOf(column.name) !== -1) column.is_pk = true;
      });
    }
  }
}

function ensureTable(name) {
  var key = lower(name);
  if (!byName[key]) {
    byName[key] = blankTable(name);
    tables.push(byName[key]);
  }
  return byName[key];
}

function handleStatement(start, semicolon, text) {
  if (CREATE_RE.test(text)) {
    var parsed = parseCreate(text);
    if (!parsed) return;
    var key = lower(parsed.name);
    var existing = byName[key];
    if (existing) {                       // keep any data already indexed
      parsed.spans = existing.spans;
      parsed.bytes = existing.bytes;
      tables[tables.indexOf(existing)] = parsed;
    } else {
      tables.push(parsed);
    }
    byName[key] = parsed;
    return;
  }

  var insert = INSERT_RE.exec(text);
  if (insert) {
    var table = ensureTable(unquote(insert[1]));
    var prefix = text.slice(0, insert.index + insert[0].length);
    var payloadStart = start + byteLength(prefix);
    var columns = insert[2] ? splitIdentifiers(insert[2].slice(1, -1)) : null;
    if (columns && !table.columns.length) {
      table.columns = columns.map(function (name) {
        return { name: name, type: "?", nullable: true, default: null,
                 is_pk: false, is_unique: false, auto_increment: false };
      });
    }
    table.spans.push({ start: payloadStart, end: semicolon, columns: columns });
    table.bytes += semicolon - payloadStart;
    return;
  }

  if (ALTER_RE.test(text)) applyAlter(text);
}

// ---------------------------------------------------------------- row reading

/* Find complete row tuples inside [from, to) of a loaded window. Returns the
 * spans plus the offset just past the last complete tuple, so a caller can
 * resume there without carrying scanner state between reads. */
function findTuples(bytes, base, from, to, limit) {
  var spans = [];
  var i = from - base;
  var hi = Math.min(bytes.length, to - base);
  var complete = from;

  while (i < hi && spans.length < limit) {
    while (i < hi && bytes[i] !== OPEN) i++;
    if (i >= hi) break;
    var start = i + 1;
    var depth = 1, quote = 0, j = start;
    while (j < hi) {
      var b = bytes[j];
      if (quote) {
        if (b === BSLASH) { j += 2; continue; }
        if (b === quote) {
          if (j + 1 < hi && bytes[j + 1] === quote) { j += 2; continue; }
          quote = 0;
        }
      } else if (b === QUOTE || b === DQUOTE) quote = b;
      else if (b === OPEN) depth++;
      else if (b === CLOSE) { depth--; if (!depth) break; }
      j++;
    }
    if (j >= hi) break;                    // tuple truncated by this window
    spans.push([base + start, base + j]);
    complete = base + j + 1;
    i = j + 1;
  }
  return { spans: spans, next: complete };
}

var ESCAPES = { n: "\n", r: "\r", t: "\t", "0": "\0", Z: "\x1a", b: "\b" };

function coerce(raw) {
  var token = raw.trim();
  if (!token) return null;
  var upper = token.toUpperCase();
  if (upper === "NULL") return null;
  if (upper === "TRUE" || upper === "FALSE") return upper === "TRUE";
  if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
    var inner = token.slice(1, -1).replace(/''/g, "'");
    if (inner.indexOf("\\") !== -1) {
      inner = inner.replace(/\\([\s\S])/g, function (match, ch) {
        return Object.prototype.hasOwnProperty.call(ESCAPES, ch) ? ESCAPES[ch] : ch;
      });
    }
    return inner;
  }
  if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)) {
    var value = Number(token);
    // Keep the dump's text when it would not round-trip, so DECIMAL(10,2)
    // 49.00 is not displayed as 49.
    return String(value) === token ? value : token;
  }
  return token;
}

function parseTuple(text) {
  var values = [];
  var depth = 0, quote = 0, start = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { if (text[i + 1] === quote) i++; else quote = 0; }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { values.push(coerce(text.slice(start, i))); start = i + 1; }
  }
  values.push(coerce(text.slice(start)));
  return values;
}

function alignRow(values, segmentColumns, columns) {
  if (segmentColumns && columns.length) {
    var same = segmentColumns.length === columns.length &&
      segmentColumns.every(function (name, i) { return name === columns[i]; });
    if (!same) {
      var lookup = Object.create(null);
      segmentColumns.forEach(function (name, i) { lookup[name] = values[i]; });
      return columns.map(function (name) {
        return Object.prototype.hasOwnProperty.call(lookup, name) ? lookup[name] : null;
      });
    }
  }
  if (columns.length) {
    var out = values.slice(0, columns.length);
    while (out.length < columns.length) out.push(null);
    return out;
  }
  return values;
}

// Case-insensitive byte search, folding ASCII only. `needle` is lower-cased.
function foldedIndexOf(bytes, needle, from, to) {
  var first = needle[0];
  var length = needle.length;
  for (var i = from; i + length <= to; i++) {
    var b = bytes[i];
    if (b >= 65 && b <= 90) b += 32;
    if (b !== first) continue;
    var hit = true;
    for (var j = 1; j < length; j++) {
      var c = bytes[i + j];
      if (c >= 65 && c <= 90) c += 32;
      if (c !== needle[j]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return -1;
}

/* Walk a table's data, invoking visit(span, bytes, base, insertSpan, spanIndex)
 * per row tuple. Reading resumes at tuple boundaries, so no scanner state has
 * to cross reads. Returning false from visit stops the walk. */
async function walkRows(table, startSpan, startOffset, visit, shouldStop) {
  var spanIndex = startSpan;
  var offset = startOffset;

  while (spanIndex < table.spans.length) {
    var span = table.spans[spanIndex];
    var from = Math.max(offset || span.start, span.start);
    var window = ROW_WINDOW;

    while (from < span.end) {
      if (shouldStop && shouldStop()) return { spanIndex: spanIndex, offset: from, stopped: true };
      var to = Math.min(from + window, span.end);
      var bytes = await readBytes(from, to);
      var found = findTuples(bytes, from, from, to, Infinity);

      for (var i = 0; i < found.spans.length; i++) {
        if (visit(found.spans[i], bytes, from, span, spanIndex) === false) {
          return { spanIndex: spanIndex, offset: found.spans[i][1] + 1, stopped: true };
        }
      }

      if (!found.spans.length) {
        if (to >= span.end || window >= MAX_WINDOW) break;
        window *= 4;                        // a single row larger than the window
        continue;
      }
      window = ROW_WINDOW;
      from = found.next;
    }

    spanIndex++;
    offset = 0;
  }
  return { spanIndex: spanIndex, offset: 0, stopped: false };
}

// ---------------------------------------------------------------- page serving

function cursorMap(table) {
  var key = lower(table.name);
  if (!cursors[key]) cursors[key] = { 1: { spanIndex: 0, offset: 0 } };
  return cursors[key];
}

function nearestCursor(table, page) {
  var map = cursorMap(table);
  var best = 1;
  Object.keys(map).forEach(function (key) {
    var value = Number(key);
    if (value <= page && value > best) best = value;
  });
  return { page: best, position: map[best] };
}

// A checkpoint lands us near a row without scanning from the table's start.
function checkpointFor(table, rowIndex) {
  if (!table.checkpoints || !table.stride) return null;
  var slot = Math.floor(rowIndex / table.stride);
  if (slot >= table.checkpoints.length) slot = table.checkpoints.length - 1;
  if (slot < 0) return null;
  return {
    row: slot * table.stride,
    spanIndex: table.checkpointSpans[slot],
    offset: table.checkpoints[slot],
  };
}

async function readPage(table, page, pageSize) {
  var target = (page - 1) * pageSize;

  // Start from whichever known position is closest to the target row: a
  // checkpoint from the background index, or the cursor left by an earlier page.
  var cursor = nearestCursor(table, page);
  var start = {
    row: (cursor.page - 1) * pageSize,
    spanIndex: cursor.position.spanIndex,
    offset: cursor.position.offset,
  };
  var checkpoint = checkpointFor(table, target);
  if (checkpoint && checkpoint.row > start.row) start = checkpoint;

  var columns = table.columns.map(function (column) { return column.name; });
  var index = start.row;
  var rows = [];
  var firstByte = null, lastByte = null;
  var endPosition = null;

  await walkRows(table, start.spanIndex, start.offset, function (span, bytes, base, insertSpan, spanIndex) {
    if (index >= target) {
      if (firstByte === null) firstByte = span[0];
      rows.push(alignRow(
        parseTuple(decoder.decode(bytes.subarray(span[0] - base, span[1] - base))),
        insertSpan.columns, columns));
      lastByte = span[1];
      if (rows.length >= pageSize) {
        endPosition = { spanIndex: spanIndex, offset: span[1] + 1 };
        index++;
        return false;
      }
    }
    index++;
    return true;
  });

  return {
    rows: rows,
    endPosition: endPosition,
    bytesRead: firstByte === null ? 0 : lastByte - firstByte,
    reachedEnd: endPosition === null,
    rowsSeen: index,
  };
}

async function searchRows(table, needleText, id) {
  var key = lower(table.name) + " " + needleText;
  if (searches[key]) return searches[key];

  var needle = encoder.encode(needleText.toLowerCase());
  var matches = [];
  var scanned = 0;
  var lastPost = Date.now();

  await walkRows(table, 0, 0, function (span, bytes, base, insertSpan) {
    scanned = span[1];
    if (foldedIndexOf(bytes, needle, span[0] - base, span[1] - base) !== -1) {
      matches.push({ span: span, columns: insertSpan.columns });
      if (matches.length >= SEARCH_CAP) return false;
    }
    var now = Date.now();
    if (now - lastPost > 300) {
      lastPost = now;
      self.postMessage({ t: "searchProgress", id: id, scanned: scanned, total: file.size, found: matches.length });
    }
    return true;
  }, function () { return cancelled[id]; });

  searches[key] = matches;
  return matches;
}

async function rowsFor(message) {
  var table = byName[lower(message.table)];
  if (!table) throw new Error("Table not found");
  var pageSize = message.pageSize;
  var page = Math.max(1, message.page);
  var columns = table.columns.map(function (column) { return column.name; });
  var query = (message.query || "").trim();

  var rows = [];
  var total = null;
  var estimated = null;
  var exact = false;
  var hasMore = false;

  if (query) {
    var matches = await searchRows(table, query, message.id);
    total = matches.length;
    exact = matches.length < SEARCH_CAP;
    var slice = matches.slice((page - 1) * pageSize, page * pageSize);
    for (var i = 0; i < slice.length; i++) {
      var bytes = await readBytes(slice[i].span[0], slice[i].span[1]);
      rows.push(alignRow(parseTuple(decoder.decode(bytes)), slice[i].columns, columns));
    }
    hasMore = page * pageSize < total;
  } else {
    var result = await readPage(table, page, pageSize);
    rows = result.rows;
    hasMore = !result.reachedEnd;

    if (table.row_count !== null) {
      total = table.row_count;
      exact = true;
    } else if (result.reachedEnd) {          // walked off the end: count is known
      total = result.rowsSeen;
      exact = true;
      table.row_count = total;
    } else if (table.bytes && rows.length && result.bytesRead) {
      // No exact count yet, so approximate from the bytes this page occupied.
      estimated = Math.max(rows.length, Math.round(table.bytes / (result.bytesRead / rows.length)));
    }

    if (result.endPosition) cursorMap(table)[page + 1] = result.endPosition;
  }

  return {
    table: table.name,
    columns: columns,
    column_meta: table.columns,
    primary_key: table.primary_key,
    foreign_keys: table.foreign_keys,
    rows: rows,
    page: page,
    page_size: pageSize,
    total_rows: total,
    estimated_rows: estimated,
    total_pages: total === null ? null : Math.max(1, Math.ceil(total / pageSize)),
    filtered: !!query,
    exact: exact,
    has_more: hasMore,
    capped: !!query && !exact,
  };
}

// Count rows and record checkpoints for one table only.
async function buildIndex(message) {
  var table = byName[lower(message.table)];
  if (!table) return;
  if (table.checkpoints) {
    self.postMessage({ t: "indexed", id: message.id, table: table.name, row_count: table.row_count });
    return;
  }

  var stride = 1000;
  var offsets = [];
  var spanIds = [];
  var count = 0;
  var lastPost = Date.now();

  await walkRows(table, 0, 0, function (span, bytes, base, insertSpan, spanIndex) {
    if (count % stride === 0) {
      offsets.push(span[0] - 1);
      spanIds.push(spanIndex);
      if (offsets.length > CHECKPOINT_CAP) {      // halve resolution, keep memory flat
        var thinnedOffsets = [], thinnedSpans = [];
        for (var i = 0; i < offsets.length; i += 2) {
          thinnedOffsets.push(offsets[i]);
          thinnedSpans.push(spanIds[i]);
        }
        offsets = thinnedOffsets;
        spanIds = thinnedSpans;
        stride *= 2;
      }
    }
    count++;
    var now = Date.now();
    if (now - lastPost > 300) {
      lastPost = now;
      self.postMessage({ t: "indexProgress", id: message.id, table: table.name, rows: count });
    }
    return true;
  }, function () { return cancelled[message.id]; });

  if (cancelled[message.id]) return;
  table.row_count = count;
  table.stride = stride;
  table.checkpoints = Float64Array.from(offsets);
  table.checkpointSpans = Int32Array.from(spanIds);
  self.postMessage({ t: "indexed", id: message.id, table: table.name, row_count: count });
}

// ---------------------------------------------------------------- protocol

function tableSummary(table) {
  return {
    name: table.name,
    columns: table.columns,
    primary_key: table.primary_key,
    foreign_keys: table.foreign_keys,
    row_count: table.row_count,
    column_count: table.columns.length,
    data_bytes: table.bytes,
    indexed: !!table.checkpoints,
  };
}

function schemaPayload(partial, scanned) {
  var known = Object.create(null);
  tables.forEach(function (table) { known[lower(table.name)] = true; });
  var relations = [];
  tables.forEach(function (table) {
    table.foreign_keys.forEach(function (fk) {
      relations.push({
        from_table: table.name,
        to_table: fk.ref_table,
        columns: fk.columns,
        ref_columns: fk.ref_columns,
        resolved: !!known[lower(fk.ref_table)],
      });
    });
  });
  return {
    tables: tables.map(tableSummary),
    relations: relations,
    table_count: tables.length,
    row_count: tables.reduce(function (sum, t) { return sum + (t.row_count || 0); }, 0),
    partial: partial,
    scanned: scanned,
    total: file ? file.size : 0,
  };
}

async function open(message) {
  file = message.file;
  tables = [];
  byName = Object.create(null);
  cursors = Object.create(null);
  searches = Object.create(null);

  var state = newScanState();
  var next = chunkReader(0, file.size);
  var scanned = 0;
  var lastPost = 0;
  var pending;

  while ((pending = next())) {
    var chunk = await pending;
    scanChunk(chunk.bytes, chunk.base, state, handleStatement);
    scanned = chunk.base + chunk.bytes.length;
    var now = Date.now();
    if (now - lastPost > 250) {
      lastPost = now;
      self.postMessage({ t: "progress", schema: schemaPayload(true, scanned) });
    }
  }
  self.postMessage({ t: "schema", id: message.id, schema: schemaPayload(false, file.size) });
}

self.onmessage = function (event) {
  var message = event.data;

  if (message.t === "cancel") { cancelled[message.id] = true; return; }

  var work;
  if (message.t === "open") work = open(message);
  else if (message.t === "rows") {
    work = rowsFor(message).then(function (payload) {
      self.postMessage({ t: "rows", id: message.id, payload: payload });
    });
  } else if (message.t === "index") work = buildIndex(message);
  else return;

  work.catch(function (error) {
    self.postMessage({ t: "error", id: message.id, message: String((error && error.message) || error) });
  });
};
