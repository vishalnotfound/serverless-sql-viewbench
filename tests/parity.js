/* Dump every fixture through the browser worker as JSON, in the same shape as
 * tests/parity.py, so the two grammars can be diffed.
 *
 * Needs the app running (default http://127.0.0.1:8811) and playwright-core.
 * Usage: node tests/parity.js [baseUrl] > out.json
 */
"use strict";

const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8811";
const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || "playwright";
const FIXTURES = path.join(__dirname, "fixtures");
const PAGE = 100;

// Minimal page whose only job is to host the worker on the app's origin.
const HARNESS = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<input type="file" id="f" multiple>
<script>
window.run = function (pageSize) {
  const files = Array.from(document.getElementById('f').files);
  const worker = new Worker('/static/worker.js');
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = e => {
    const m = e.data;
    if (m.t === 'progress' || m.t === 'indexProgress' || m.t === 'searchProgress') return;
    const key = m.t === 'schema' ? 'schema:' + m.id : m.t + ':' + m.id;
    const resolve = waiting.get(key);
    if (resolve) { waiting.delete(key); resolve(m); }
  };
  const send = (msg, expect) => new Promise(res => {
    msg.id = ++seq;
    waiting.set(expect + ':' + msg.id, res);
    worker.postMessage(msg);
  });

  return (async () => {
    const out = [];
    for (const file of files) {
      const opened = await send({ t: 'open', file }, 'schema');
      const tables = [];
      for (const t of opened.schema.tables) {
        const got = await send({ t: 'rows', table: t.name, page: 1, pageSize, query: '' }, 'rows');
        tables.push({
          name: t.name,
          columns: t.columns,
          primary_key: t.primary_key,
          foreign_keys: t.foreign_keys,
          row_count: got.payload.total_rows,
          rows: got.payload.rows,
        });
      }
      out.push({ file: file.name, tables });
    }
    return out;
  })();
};
</script></body></html>`;

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  await page.route(BASE + "/__parity", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: HARNESS }));
  await page.goto(BASE + "/__parity");

  const files = fs.readdirSync(FIXTURES).filter(f => f.endsWith(".sql")).sort()
    .map(f => path.join(FIXTURES, f));
  await page.setInputFiles("#f", files);

  const result = await page.evaluate(size => window.run(size), PAGE);
  await browser.close();

  if (errors.length) {
    console.error("page errors:\n" + errors.join("\n"));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2));
})().catch(e => { console.error("FAILED", e.message); process.exit(1); });
