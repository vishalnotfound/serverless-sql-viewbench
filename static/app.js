/* SQL Dump Viewbench - client. Vanilla JS, no build step, no CDN. */
(function () {
  "use strict";

  var state = {
    files: [],         // dumps stored on the server
    local: [],         // files opened from this machine, never uploaded
    source: null,      // ServerSource or LocalSource
    file: null,
    schema: null,
    table: null,
    page: 1,
    pageSize: 50,
    query: "",
    view: "tables",
    scanning: false,
    booting: true,
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- helpers

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function num(value) { return Number(value).toLocaleString(); }

  function bytes(size) {
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return (i === 0 ? size : size.toFixed(1)) + " " + units[i];
  }

  function debounce(fn, wait) {
    var timer;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function toast(message, kind) {
    var el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = message;
    $("toasts").appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  var pending = 0;
  function progress(active) {
    var bar = $("progress");
    pending += active ? 1 : -1;
    if (pending > 0) {
      bar.classList.remove("done");
      bar.style.width = "70%";
    } else {
      pending = 0;
      bar.style.width = "100%";
      bar.classList.add("done");
      setTimeout(function () { bar.style.width = "0"; }, 300);
    }
  }

  async function api(path, options) {
    progress(true);
    try {
      var response = await fetch(path, options);
      var body = null;
      try { body = await response.json(); } catch (e) { /* empty body */ }
      if (!response.ok) {
        throw new Error((body && body.detail) || response.statusText || "Request failed");
      }
      return body;
    } finally {
      progress(false);
    }
  }

  // ---------------------------------------------------------------- routing

  function writeHash() {
    var hash = state.file ? "#/" + encodeURIComponent(state.file) : "";
    if (state.file && state.table) hash += "/" + encodeURIComponent(state.table);
    else if (state.file && state.view === "diagram") hash += "/~diagram";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  }

  function readHash() {
    var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    return {
      file: parts[0] ? decodeURIComponent(parts[0]) : null,
      table: parts[1] ? decodeURIComponent(parts[1]) : null,
    };
  }

  // ---------------------------------------------------------------- panes

  function showPane(name) {
    ["welcome", "tables", "diagram", "data", "structure"].forEach(function (pane) {
      $("pane-" + pane).classList.toggle("active", pane === name);
    });
  }

  function setView(view) {
    state.view = view;
    state.table = null;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.classList.toggle("active", tab.dataset.view === view);
    });
    showPane(view);
    if (view === "diagram") erd.render();
    renderCrumbs();
    writeHash();
  }

  function renderCrumbs() {
    var crumbs = $("crumbs");
    if (!state.file) {
      crumbs.innerHTML = '<span class="crumb">Select a dump to begin</span>';
      return;
    }
    var html = '<span class="crumb ' + (state.table ? "link" : "current") + '" data-act="file">' +
      esc(state.file) + "</span>";
    if (state.table) {
      html += '<span class="crumb-sep">/</span><span class="crumb current">' + esc(state.table) + "</span>";
    }
    crumbs.innerHTML = html;
  }

  function renderStats() {
    if (!state.schema) { $("stats").innerHTML = ""; return; }
    var schema = state.schema;
    var uncounted = (schema.tables || []).some(function (table) {
      return table.row_count === null || table.row_count === undefined;
    });

    // Rows are only claimed once they have actually been counted; until then
    // report the data size, which is known from the index pass.
    var middle;
    if (!uncounted) {
      middle = "<span><b>" + num(schema.row_count) + "</b> rows</span>";
    } else {
      var dataBytes = (schema.tables || []).reduce(function (sum, table) {
        return sum + (table.data_bytes || 0);
      }, 0);
      middle = "<span><b>" + bytes(dataBytes) + "</b> of rows</span>";
    }

    $("stats").innerHTML =
      "<span><b>" + num(schema.table_count) + "</b> tables</span>" +
      middle +
      "<span><b>" + num(schema.relations.length) + "</b> relations</span>";
  }

  // ---------------------------------------------------------------- files

  function matches(name, filter) {
    return !filter || name.toLowerCase().indexOf(filter) !== -1;
  }

  function fileRow(name, size, kind, active, extra) {
    return '<div class="file' + (active ? " active" : "") + '" data-kind="' + kind +
      '" data-name="' + esc(name) + '">' +
      '<div class="file-body">' +
      '<div class="file-name">' + esc(name) + "</div>" +
      '<div class="file-meta">' + bytes(size) + (extra ? " &middot; " + extra : "") + "</div>" +
      "</div>" +
      (kind === "server"
        ? '<button class="file-del" data-del="' + esc(name) + '" title="Delete">&times;</button>'
        : '<button class="file-del" data-close="' + esc(name) + '" title="Close">&times;</button>') +
      "</div>";
  }

  function renderFiles() {
    var filter = $("file-filter").value.trim().toLowerCase();
    var list = $("file-list");
    var html = "";

    var local = state.local.filter(function (entry) { return matches(entry.name, filter); });
    if (local.length) {
      html += '<div class="group-label">On this machine</div>';
      html += local.map(function (entry) {
        var active = state.source && state.source.kind === "local" && state.file === entry.name;
        return fileRow(entry.name, entry.size, "local", active,
          entry.scanned ? "" : "indexing");
      }).join("");
    }

    var server = state.files.filter(function (file) { return matches(file.name, filter); });
    if (server.length) {
      if (local.length) html += '<div class="group-label">On the server</div>';
      html += server.map(function (file) {
        var active = state.source && state.source.kind === "server" && state.file === file.name;
        return fileRow(file.name, file.size, "server", active, "");
      }).join("");
    }

    if (!html) {
      html = '<div class="loading">' +
        (state.files.length || state.local.length ? "No match." : "No dumps yet.") + "</div>";
    }
    list.innerHTML = html;
  }

  async function loadFiles() {
    try {
      state.files = await api("/api/files");
      renderFiles();
    } catch (error) {
      toast("Could not list files: " + error.message, "error");
    }
  }

  async function upload(file) {
    if (!file) return;
    var form = new FormData();
    form.append("file", file);
    try {
      var saved = await api("/api/files/upload", { method: "POST", body: form });
      toast(saved.name + " uploaded", "success");
      await loadFiles();
      selectFile(saved.name);
    } catch (error) {
      toast("Upload failed: " + error.message, "error");
    }
  }

  async function remove(name) {
    if (!confirm("Delete " + name + "?")) return;
    try {
      await api("/api/files/" + encodeURIComponent(name), { method: "DELETE" });
      if (state.source && state.source.kind === "server" && state.file === name) clearView();
      await loadFiles();
      toast(name + " deleted", "success");
    } catch (error) {
      toast("Delete failed: " + error.message, "error");
    }
  }

  // ---------------------------------------------------------------- schema

  function setScanProgress(schema) {
    var bar = $("scan");
    if (!schema || !schema.partial) {
      bar.hidden = true;
      state.scanning = false;
      return;
    }
    state.scanning = true;
    bar.hidden = false;
    var percent = schema.total ? Math.min(100, (schema.scanned / schema.total) * 100) : 0;
    $("scan-fill").style.width = percent.toFixed(1) + "%";
    $("scan-text").textContent = "Indexing " + percent.toFixed(0) + "% · " +
      schema.table_count + " tables found · " + bytes(schema.scanned) + " of " + bytes(schema.total);
  }

  // Applies a schema snapshot, which for a local file arrives repeatedly as the
  // scan discovers more tables.
  function applySchema(schema) {
    state.schema = schema;
    setScanProgress(schema);
    renderStats();
    renderTables();
    if (state.view === "diagram") erd.rerender();
  }

  async function openSource(source, keepView) {
    if (state.source && state.source !== source) state.source.close();
    state.source = source;
    state.file = source.name;
    state.table = null;
    state.schema = null;
    state.query = "";
    renderFiles();
    renderCrumbs();
    $("tabs").hidden = false;
    $("table-rows").innerHTML = '<tr><td colspan="4" class="loading">Reading dump…</td></tr>';
    if (!keepView) setView("tables");

    try {
      var schema = await source.schema();
    } catch (error) {
      toast("Could not read dump: " + error.message, "error");
      $("table-rows").innerHTML = '<tr><td colspan="4" class="loading">Failed to parse.</td></tr>';
      return;
    }
    if (state.source !== source) return;          // another file was opened
    state.local.forEach(function (entry) {
      if (entry.name === source.name) entry.scanned = true;
    });
    applySchema(schema);
    erd.reset();
    if (state.view === "diagram") erd.render();
    renderFiles();
  }

  function selectFile(name, keepView) {
    return openSource(new window.Sources.ServerSource(name), keepView);
  }

  function clearView() {
    if (state.source) state.source.close();
    state.source = null;
    state.file = null;
    state.schema = null;
    state.table = null;
    $("tabs").hidden = true;
    $("scan").hidden = true;
    showPane("welcome");
    renderCrumbs();
    renderStats();
    writeHash();
  }

  function closeLocal(name) {
    state.local = state.local.filter(function (entry) { return entry.name !== name; });
    if (state.source && state.source.kind === "local" && state.file === name) clearView();
    renderFiles();
  }

  function openLocalFile(file) {
    var existing = null;
    state.local.forEach(function (entry) {
      if (entry.name === file.name && entry.size === file.size) existing = entry;
    });
    if (!existing) {
      existing = { name: file.name, size: file.size, file: file, scanned: false };
      state.local.push(existing);
    } else {
      existing.file = file;
      existing.scanned = false;
    }

    var source = new window.Sources.LocalSource(file, {
      onProgress: function (schema) {
        if (state.source === source) applySchema(schema);
      },
      onIndexProgress: function (message) {
        if (state.source === source && state.table === message.table) {
          $("row-summary").textContent = "counting… " + num(message.rows) + " rows so far";
        }
      },
      onSearchProgress: function (message) {
        if (state.source === source) {
          $("row-summary").textContent = "searching " +
            ((message.scanned / message.total) * 100).toFixed(0) + "% · " +
            num(message.found) + " found";
        }
      },
      onError: function (text) { toast("Worker error: " + text, "error"); },
    });
    return openSource(source);
  }

  /* A local dump has no row count until that table has been indexed, so show
   * the data size instead of a number the app has not actually counted. */
  function rowCountLabel(table) {
    if (table.row_count !== null && table.row_count !== undefined) return num(table.row_count);
    if (table.data_bytes) {
      return '<span title="not counted yet" style="color:var(--faint)">' + bytes(table.data_bytes) + "</span>";
    }
    return '<span style="color:var(--faint)">&mdash;</span>';
  }

  function renderTables() {
    var schema = state.schema;
    if (!schema) return;
    var filter = $("table-filter").value.trim().toLowerCase();
    var tables = schema.tables.filter(function (table) {
      return !filter || table.name.toLowerCase().indexOf(filter) !== -1;
    });

    $("table-count").textContent = tables.length + " of " + schema.tables.length;

    if (!tables.length) {
      $("table-rows").innerHTML = '<tr><td colspan="4" class="loading">' +
        (schema.tables.length ? "No table matches." : "No CREATE TABLE statements found.") +
        "</td></tr>";
      return;
    }

    $("table-rows").innerHTML = tables.map(function (table) {
      var keys = "";
      if (table.primary_key.length) {
        keys += '<span class="chip pk">PK ' + esc(table.primary_key.join(", ")) + "</span>";
      }
      if (table.foreign_keys.length) {
        keys += '<span class="chip fk">' + table.foreign_keys.length + " FK</span>";
      }
      return '<tr data-table="' + esc(table.name) + '">' +
        '<td><div class="tname"><span class="dot"></span>' + esc(table.name) + "</div></td>" +
        "<td>" + (keys || '<span style="color:var(--faint)">&mdash;</span>') + "</td>" +
        '<td class="num">' + num(table.column_count) + "</td>" +
        '<td class="num">' + rowCountLabel(table) + "</td>" +
        "</tr>";
    }).join("");
  }

  // ---------------------------------------------------------------- rows

  function cell(value) {
    if (value === null || value === undefined) return '<td><span class="null">NULL</span></td>';
    if (typeof value === "number") return '<td class="numval">' + value + "</td>";
    if (typeof value === "boolean") return '<td class="boolval">' + value + "</td>";
    var text = String(value);
    // Numbers kept as text to preserve exact decimals still read as numbers.
    if (/^-?\d+(\.\d+)?$/.test(text)) return '<td class="numval">' + text + "</td>";
    var clipped = text.length > 240 ? text.slice(0, 240) + "\u2026" : text;
    return '<td title="' + esc(text.slice(0, 600)) + '">' + esc(clipped) + "</td>";
  }

  async function openTable(name, page) {
    var source = state.source;
    if (!source) return;
    state.table = name;
    state.page = page || 1;
    showPane("data");
    renderCrumbs();
    writeHash();

    var data;
    progress(true);
    try {
      data = await source.rows(name, state.page, state.pageSize, state.query);
    } catch (error) {
      toast("Could not read table: " + error.message, "error");
      return;
    } finally {
      progress(false);
    }
    if (state.table !== name || state.source !== source) return;   // a newer request won
    state.current = data;
    renderGrid(data);
    countInBackground(source, name);
  }

  /* A local table has no exact row count until its own data has been walked.
   * That runs once per table, in the worker, while the first page is on screen. */
  function countInBackground(source, name) {
    if (source.kind !== "local") return;
    var table = null;
    (state.schema.tables || []).forEach(function (entry) {
      if (entry.name === name) table = entry;
    });
    if (!table || table.row_count !== null || table.counting) return;
    table.counting = true;

    source.index(name).then(function (result) {
      table.counting = false;
      if (!result) return;
      table.row_count = result.row_count;
      table.indexed = true;
      renderTables();
      renderStats();
      if (state.table === name && state.source === source && !state.query) {
        openTable(name, state.page);      // redraw with exact totals
      }
    }).catch(function () { table.counting = false; });
  }

  function renderGrid(data) {
    var meta = {};
    data.column_meta.forEach(function (column) { meta[column.name] = column; });
    var fkColumns = {};
    data.foreign_keys.forEach(function (fk) {
      fk.columns.forEach(function (column) { fkColumns[column] = fk; });
    });

    $("grid-head").innerHTML = "<tr><th class=\"rownum\">#</th>" + data.columns.map(function (name) {
      var column = meta[name] || {};
      var mark = column.is_pk ? '<span style="color:var(--pk)">&#9679;</span> ' :
        (fkColumns[name] ? '<span style="color:var(--fk)">&#9679;</span> ' : "");
      var type = column.type ? '<span class="type">' + esc(column.type) + "</span>" : "";
      var title = [column.type, column.nullable === false ? "NOT NULL" : "",
        fkColumns[name] ? "-> " + fkColumns[name].ref_table : ""].filter(Boolean).join(" ");
      return '<th title="' + esc(title) + '">' + mark + esc(name) + type + "</th>";
    }).join("") + "</tr>";

    var offset = (data.page - 1) * data.page_size;
    if (!data.rows.length) {
      $("grid-body").innerHTML = '<tr><td class="loading" colspan="' +
        (data.columns.length + 1) + '">' +
        (data.filtered ? "No row matches this search." : "This table has no INSERT data in the dump.") +
        "</td></tr>";
    } else {
      $("grid-body").innerHTML = data.rows.map(function (row, index) {
        return '<tr><td class="rownum">' + (offset + index + 1) + "</td>" +
          row.map(cell).join("") + "</tr>";
      }).join("");
    }

    var first = data.rows.length ? offset + 1 : 0;
    var last = offset + data.rows.length;
    var summary;
    if (data.total_rows !== null && data.total_rows !== undefined) {
      summary = first + "-" + last + " of " + num(data.total_rows) +
        (data.capped ? "+" : "") + (data.filtered ? " matched" : " rows");
    } else if (state.scanning) {
      // Mid-scan an estimate only covers the bytes seen so far, so don't quote one.
      summary = first + "-" + last + " · indexing…";
    } else if (data.estimated_rows) {
      summary = first + "-" + last + " of ~" + num(data.estimated_rows) + " rows · counting…";
    } else {
      summary = first + "-" + last;
    }
    $("row-summary").textContent = summary;

    $("page-label").textContent = "Page " + data.page +
      (data.total_pages ? " / " + data.total_pages : "");
    $("page-first").disabled = $("page-prev").disabled = data.page <= 1;
    $("page-next").disabled = !data.has_more;
    $("page-last").disabled = !data.total_pages || data.page >= data.total_pages;
    $("grid-wrap").scrollTop = 0;
  }

  function renderStructure() {
    var data = state.current;
    if (!data) return;
    var referencedBy = (state.schema.relations || []).filter(function (relation) {
      return relation.to_table.toLowerCase() === data.table.toLowerCase();
    });

    var columns = '<div class="card"><h3>Columns</h3><table class="table-list"><thead><tr>' +
      "<th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th></tr></thead><tbody>" +
      data.column_meta.map(function (column) {
        var key = column.is_pk ? '<span class="chip pk">PK</span>' :
          (column.is_unique ? '<span class="chip">UNIQUE</span>' : "");
        return "<tr style=\"cursor:default\"><td class=\"mono\">" + esc(column.name) + "</td>" +
          '<td class="mono" style="color:var(--muted)">' + esc(column.type) + "</td>" +
          '<td style="color:var(--muted)">' + (column.nullable ? "YES" : "NO") + "</td>" +
          '<td class="mono" style="color:var(--muted)">' +
          (column.default === null ? "&mdash;" : esc(column.default)) + "</td>" +
          "<td>" + (key || "") + (column.auto_increment ? '<span class="chip">AUTO</span>' : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    function relationRows(list, outgoing) {
      if (!list.length) return '<div class="rel-row" style="color:var(--faint)">None</div>';
      return list.map(function (relation) {
        var target = outgoing ? relation.ref_table : relation.from_table;
        var cols = outgoing ? relation.columns : relation.columns;
        return '<div class="rel-row"><span class="mono">' + esc(cols.join(", ")) + "</span>" +
          '<span class="arrow">' + (outgoing ? "&rarr;" : "&larr;") + "</span>" +
          '<span class="link mono" data-goto="' + esc(target) + '">' + esc(target) + "</span>" +
          (outgoing && relation.ref_columns.length
            ? '<span class="mono" style="color:var(--faint)">(' + esc(relation.ref_columns.join(", ")) + ")</span>"
            : "") + "</div>";
      }).join("");
    }

    $("struct").innerHTML = columns +
      '<div class="card"><h3>References</h3>' + relationRows(data.foreign_keys, true) + "</div>" +
      '<div class="card"><h3>Referenced by</h3>' + relationRows(referencedBy, false) + "</div>";
  }

  // ---------------------------------------------------------------- diagram

  var erd = (function () {
    var svg, root, edgeLayer, nodeLayer;
    var nodes = [], edges = [], byName = {};
    var scale = 1, tx = 0, ty = 0;
    var dirty = true;
    var ROW_HEIGHT = 17, HEAD_HEIGHT = 30, PAD = 10, MAX_COLUMNS = 14;

    function init() {
      svg = $("erd");
      root = document.createElementNS("http://www.w3.org/2000/svg", "g");
      edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      root.appendChild(edgeLayer);
      root.appendChild(nodeLayer);
      svg.appendChild(root);
      bindInteractions();
    }

    function reset() {
      dirty = true;
      // Large schemas are unreadable with every column drawn, so start compact.
      if (state.schema) $("erd-columns").checked = state.schema.tables.length <= 40;
    }

    function measure(table, showColumns) {
      var visible = showColumns ? Math.min(table.columns.length, MAX_COLUMNS) : 0;
      var longest = table.name.length + 4;
      for (var i = 0; i < visible; i++) {
        var column = table.columns[i];
        longest = Math.max(longest, column.name.length + column.type.length + 3);
      }
      var extra = showColumns && table.columns.length > MAX_COLUMNS ? 1 : 0;
      return {
        w: Math.max(150, Math.min(300, longest * 6.6 + 24)),
        h: HEAD_HEIGHT + (visible + extra) * ROW_HEIGHT + (visible || extra ? 8 : 4),
        visible: visible,
        extra: extra,
      };
    }

    function layout(tables, relations, showColumns) {
      nodes = [];
      byName = {};
      tables.forEach(function (table) {
        var size = measure(table, showColumns);
        var node = {
          name: table.name,
          key: table.name.toLowerCase(),
          table: table,
          w: size.w,
          h: size.h,
          visible: size.visible,
          extra: size.extra,
          x: 0,
          y: 0,
          links: [],
        };
        nodes.push(node);
        byName[node.key] = node;
      });

      edges = [];
      relations.forEach(function (relation) {
        var from = byName[relation.from_table.toLowerCase()];
        var to = byName[relation.to_table.toLowerCase()];
        if (!from || !to) return;
        var edge = { from: from, to: to, relation: relation };
        edges.push(edge);
        from.links.push(edge);
        if (to !== from) to.links.push(edge);
      });

      placeNodes();
    }

    var GAP_X = 90, GAP_Y = 26, BAND_GAP = 70, ASPECT = 1.7;

    // Split a connected group into BFS depth levels, wrapping tall levels into
    // extra columns so a hub table does not produce one endless vertical strip.
    function layoutGroup(members, perColumn) {
      var root = members.reduce(function (best, node) {
        return node.links.length > best.links.length ? node : best;
      }, members[0]);

      var levels = [];
      var visited = {};
      var queue = [{ node: root, depth: 0 }];
      visited[root.key] = true;
      while (queue.length) {
        var item = queue.shift();
        (levels[item.depth] = levels[item.depth] || []).push(item.node);
        item.node.links.forEach(function (edge) {
          var next = edge.from === item.node ? edge.to : edge.from;
          if (visited[next.key]) return;
          visited[next.key] = true;
          queue.push({ node: next, depth: item.depth + 1 });
        });
      }

      var columns = [];
      levels.forEach(function (level) {
        for (var i = 0; i < level.length; i += perColumn) {
          columns.push(level.slice(i, i + perColumn));
        }
      });

      var heights = columns.map(function (column) {
        return column.reduce(function (sum, node) { return sum + node.h + GAP_Y; }, -GAP_Y);
      });
      var tallest = Math.max.apply(null, heights);

      var x = 0;
      columns.forEach(function (column, index) {
        var width = Math.max.apply(null, column.map(function (node) { return node.w; }));
        var y = (tallest - heights[index]) / 2;
        column.forEach(function (node) {
          node.x = x + (width - node.w) / 2;
          node.y = y;
          y += node.h + GAP_Y;
        });
        x += width + GAP_X;
      });

      return { members: members, w: Math.max(0, x - GAP_X), h: tallest };
    }

    function placeNodes() {
      if (!nodes.length) return;

      var groups = [];
      var seen = {};
      nodes.forEach(function (start) {
        if (seen[start.key]) return;
        var members = [];
        var stack = [start];
        seen[start.key] = true;
        while (stack.length) {
          var node = stack.pop();
          members.push(node);
          node.links.forEach(function (edge) {
            var next = edge.from === node ? edge.to : edge.from;
            if (seen[next.key]) return;
            seen[next.key] = true;
            stack.push(next);
          });
        }
        groups.push(members);
      });

      var avgW = 0, avgH = 0;
      nodes.forEach(function (node) { avgW += node.w + GAP_X; avgH += node.h + GAP_Y; });
      avgW /= nodes.length;
      avgH /= nodes.length;
      var perColumn = Math.max(3, Math.round(Math.sqrt(nodes.length * avgW / (ASPECT * avgH))));

      var boxes = groups.map(function (members) { return layoutGroup(members, perColumn); });
      boxes.sort(function (a, b) { return b.h - a.h || b.w - a.w; });

      // Shelf-pack the groups so the whole diagram keeps a screen-like shape.
      var area = boxes.reduce(function (sum, box) { return sum + (box.w + BAND_GAP) * (box.h + BAND_GAP); }, 0);
      var widest = Math.max.apply(null, boxes.map(function (box) { return box.w; }));
      var shelfWidth = Math.max(widest, Math.sqrt(area * ASPECT));

      var x = 0, y = 0, shelfHeight = 0;
      boxes.forEach(function (box) {
        if (x > 0 && x + box.w > shelfWidth) {
          x = 0;
          y += shelfHeight + BAND_GAP;
          shelfHeight = 0;
        }
        var dx = x, dy = y;
        box.members.forEach(function (node) { node.x += dx; node.y += dy; });
        x += box.w + BAND_GAP;
        shelfHeight = Math.max(shelfHeight, box.h);
      });
    }

    function nodeMarkup(node) {
      var table = node.table;
      var parts = ['<rect class="body" width="' + node.w + '" height="' + node.h + '" rx="7"></rect>'];
      parts.push('<path class="head" d="M0 7a7 7 0 0 1 7-7h' + (node.w - 14) +
        'a7 7 0 0 1 7 7v' + (HEAD_HEIGHT - 7) + 'H0z" fill="var(--panel-3)"></path>');
      parts.push('<text class="title" x="10" y="20">' + esc(table.name) + "</text>");
      parts.push('<text class="count" x="' + (node.w - 10) + '" y="20" text-anchor="end">' +
        num(table.row_count) + "</text>");

      var fkColumns = {};
      table.foreign_keys.forEach(function (fk) {
        fk.columns.forEach(function (column) { fkColumns[column] = true; });
      });

      for (var i = 0; i < node.visible; i++) {
        var column = table.columns[i];
        var cls = column.is_pk ? " pk" : (fkColumns[column.name] ? " fk" : "");
        var y = HEAD_HEIGHT + 14 + i * ROW_HEIGHT;
        var mark = column.is_pk ? "\u25c6 " : (fkColumns[column.name] ? "\u25c7 " : "");
        parts.push('<text class="col' + cls + '" x="10" y="' + y + '">' +
          esc(mark + column.name) + "</text>");
        parts.push('<text class="col" x="' + (node.w - 10) + '" y="' + y +
          '" text-anchor="end" opacity="0.6">' + esc(column.type) + "</text>");
      }
      if (node.extra) {
        parts.push('<text class="col" x="10" y="' +
          (HEAD_HEIGHT + 14 + node.visible * ROW_HEIGHT) + '" opacity="0.7">+' +
          (table.columns.length - node.visible) + " more</text>");
      }
      return '<g class="erd-node" data-name="' + esc(table.name) + '" transform="translate(' +
        node.x + "," + node.y + ')">' + parts.join("") + "</g>";
    }

    function edgePath(edge) {
      var a = edge.from, b = edge.to;
      if (a === b) {  // self reference, e.g. categories.parent_id -> categories.id
        var sx = a.x + a.w;
        var top = a.y + HEAD_HEIGHT / 2;
        var bottom = a.y + Math.min(a.h - 8, HEAD_HEIGHT + 22);
        return "M" + sx + " " + bottom + "C" + (sx + 46) + " " + bottom + " " +
          (sx + 46) + " " + top + " " + sx + " " + top;
      }
      var ax, bx, dir;
      if (b.x > a.x + a.w) { ax = a.x + a.w; bx = b.x; dir = 1; }
      else if (a.x > b.x + b.w) { ax = a.x; bx = b.x + b.w; dir = -1; }
      else { ax = a.x + a.w; bx = b.x + b.w; dir = 1; }
      var ay = a.y + Math.min(a.h / 2, HEAD_HEIGHT + 20);
      var by = b.y + HEAD_HEIGHT / 2;
      var bend = Math.max(30, Math.abs(bx - ax) * 0.4);
      return "M" + ax + " " + ay + "C" + (ax + bend * dir) + " " + ay + " " +
        (bx - bend * dir) + " " + by + " " + bx + " " + by;
    }

    function arrowMarkup(edge) {
      var b = edge.to;
      var pointsLeft = edge.from !== b && b.x > edge.from.x + edge.from.w;
      var x = pointsLeft ? b.x : b.x + b.w;
      var y = b.y + HEAD_HEIGHT / 2;
      var d = pointsLeft ? 7 : -7;
      return '<path class="erd-arrow" d="M' + x + " " + y + "L" + (x - d) + " " + (y - 4) +
        "L" + (x - d) + " " + (y + 4) + 'z"></path>';
    }

    function redrawEdges() {
      var paths = edgeLayer.querySelectorAll(".erd-edge");
      var arrows = edgeLayer.querySelectorAll(".erd-arrow");
      edges.forEach(function (edge, index) {
        if (paths[index]) paths[index].setAttribute("d", edgePath(edge));
        if (arrows[index]) {
          var markup = arrowMarkup(edge);
          arrows[index].setAttribute("d", markup.match(/d="([^"]+)"/)[1]);
        }
      });
    }

    function render() {
      if (!svg) init();
      if (!state.schema) return;
      if (!dirty) return;
      dirty = false;

      var showColumns = $("erd-columns").checked;
      var linkedOnly = $("erd-linked").checked;
      var relations = (state.schema.relations || []).filter(function (relation) {
        return relation.resolved;
      });

      var tables = state.schema.tables;
      if (linkedOnly) {
        var connected = {};
        relations.forEach(function (relation) {
          connected[relation.from_table.toLowerCase()] = true;
          connected[relation.to_table.toLowerCase()] = true;
        });
        tables = tables.filter(function (table) { return connected[table.name.toLowerCase()]; });
      }

      $("erd-count").textContent = tables.length + " tables \u00b7 " + relations.length + " relations";

      if (!tables.length) {
        nodeLayer.innerHTML = "";
        edgeLayer.innerHTML = "";
        return;
      }

      layout(tables, relations, showColumns);
      edgeLayer.innerHTML = edges.map(function (edge) {
        return '<path class="erd-edge" d="' + edgePath(edge) + '"></path>';
      }).join("") + edges.map(arrowMarkup).join("");
      nodeLayer.innerHTML = nodes.map(nodeMarkup).join("");
      nodes.forEach(function (node) {
        node.el = nodeLayer.querySelector('[data-name="' + cssEscape(node.name) + '"]');
      });
      fit();
    }

    function cssEscape(value) { return value.replace(/["\\]/g, "\\$&"); }

    function applyTransform() {
      root.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + scale + ")");
    }

    function fit() {
      if (!nodes.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (node) {
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.w); maxY = Math.max(maxY, node.y + node.h);
      });
      var box = svg.getBoundingClientRect();
      var pad = 40;
      scale = Math.min(
        (box.width - pad * 2) / Math.max(1, maxX - minX),
        (box.height - pad * 2) / Math.max(1, maxY - minY),
        1.1
      );
      scale = Math.max(0.08, scale);
      tx = pad - minX * scale + (box.width - pad * 2 - (maxX - minX) * scale) / 2;
      ty = pad - minY * scale + (box.height - pad * 2 - (maxY - minY) * scale) / 2;
      applyTransform();
    }

    function zoomBy(factor, cx, cy) {
      var box = svg.getBoundingClientRect();
      cx = cx === undefined ? box.width / 2 : cx;
      cy = cy === undefined ? box.height / 2 : cy;
      var next = Math.max(0.08, Math.min(3, scale * factor));
      tx = cx - (cx - tx) * (next / scale);
      ty = cy - (cy - ty) * (next / scale);
      scale = next;
      applyTransform();
    }

    function highlight(node) {
      var hot = {};
      if (node) {
        hot[node.key] = true;
        node.links.forEach(function (edge) {
          hot[edge.from.key] = true;
          hot[edge.to.key] = true;
        });
      }
      nodes.forEach(function (item) {
        if (!item.el) return;
        item.el.classList.toggle("hot", !!node && item.key === node.key);
        item.el.classList.toggle("dim", !!node && !hot[item.key]);
      });
      var paths = edgeLayer.querySelectorAll(".erd-edge");
      var arrows = edgeLayer.querySelectorAll(".erd-arrow");
      edges.forEach(function (edge, index) {
        var on = !!node && (edge.from.key === node.key || edge.to.key === node.key);
        [paths[index], arrows[index]].forEach(function (el) {
          if (!el) return;
          el.classList.toggle("hot", on);
          el.classList.toggle("dim", !!node && !on);
        });
      });
    }

    function focus(name) {
      var node = byName[String(name).toLowerCase()];
      highlight(node || null);
      if (!node) return;
      var box = svg.getBoundingClientRect();
      scale = Math.max(scale, 0.7);
      tx = box.width / 2 - (node.x + node.w / 2) * scale;
      ty = box.height / 2 - (node.y + node.h / 2) * scale;
      applyTransform();
    }

    function bindInteractions() {
      var drag = null;

      svg.addEventListener("mousedown", function (event) {
        var target = event.target.closest(".erd-node");
        var point = { x: event.clientX, y: event.clientY };
        if (target) {
          var node = byName[target.dataset.name.toLowerCase()];
          drag = { node: node, startX: point.x, startY: point.y, ox: node.x, oy: node.y, moved: false };
        } else {
          drag = { pan: true, startX: point.x, startY: point.y, ox: tx, oy: ty, moved: false };
          svg.classList.add("panning");
        }
        event.preventDefault();
      });

      window.addEventListener("mousemove", function (event) {
        if (!drag) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.pan) {
          tx = drag.ox + dx;
          ty = drag.oy + dy;
          applyTransform();
        } else {
          drag.node.x = drag.ox + dx / scale;
          drag.node.y = drag.oy + dy / scale;
          drag.node.el.setAttribute("transform",
            "translate(" + drag.node.x + "," + drag.node.y + ")");
          redrawEdges();
        }
      });

      window.addEventListener("mouseup", function () {
        if (drag && !drag.moved && !drag.pan) openTable(drag.node.name);
        svg.classList.remove("panning");
        drag = null;
      });

      svg.addEventListener("mouseover", function (event) {
        if (drag) return;
        var target = event.target.closest(".erd-node");
        if (target) highlight(byName[target.dataset.name.toLowerCase()]);
      });
      svg.addEventListener("mouseleave", function () { if (!drag) highlight(null); });

      svg.addEventListener("wheel", function (event) {
        event.preventDefault();
        var box = svg.getBoundingClientRect();
        zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - box.left, event.clientY - box.top);
      }, { passive: false });
    }

    return {
      render: render,
      reset: reset,
      fit: fit,
      focus: focus,
      zoomBy: zoomBy,
      rerender: function () { dirty = true; render(); },
    };
  })();

  // ---------------------------------------------------------------- events

  function bind() {
    $("file-input").addEventListener("change", function (event) {
      var file = event.target.files[0];
      event.target.value = "";
      if (file) openLocalFile(file);
    });

    $("upload-input").addEventListener("change", function (event) {
      upload(event.target.files[0]);
      event.target.value = "";
    });

    var zone = $("dropzone");
    ["dragenter", "dragover"].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.add("over");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.remove("over");
      });
    });
    // Dropping a file opens it in place; it is never sent anywhere.
    zone.addEventListener("drop", function (event) {
      if (event.dataTransfer.files.length) openLocalFile(event.dataTransfer.files[0]);
    });
    window.addEventListener("dragover", function (event) { event.preventDefault(); });
    window.addEventListener("drop", function (event) {
      event.preventDefault();
      if (event.dataTransfer && event.dataTransfer.files.length) {
        openLocalFile(event.dataTransfer.files[0]);
      }
    });

    $("file-filter").addEventListener("input", renderFiles);

    $("file-list").addEventListener("click", function (event) {
      var del = event.target.closest("[data-del]");
      if (del) { event.stopPropagation(); remove(del.dataset.del); return; }
      var close = event.target.closest("[data-close]");
      if (close) { event.stopPropagation(); closeLocal(close.dataset.close); return; }
      var file = event.target.closest(".file");
      if (!file) return;
      if (file.dataset.kind === "local") {
        var entry = null;
        state.local.forEach(function (item) {
          if (item.name === file.dataset.name) entry = item;
        });
        if (entry) openLocalFile(entry.file);
      } else {
        selectFile(file.dataset.name);
      }
    });

    $("tabs").addEventListener("click", function (event) {
      var tab = event.target.closest(".tab");
      if (tab) setView(tab.dataset.view);
    });

    $("crumbs").addEventListener("click", function (event) {
      if (event.target.closest('[data-act="file"]') && state.table) setView(state.view);
    });

    $("table-filter").addEventListener("input", debounce(renderTables, 120));

    $("table-rows").addEventListener("click", function (event) {
      var row = event.target.closest("[data-table]");
      if (row) {
        state.query = "";
        $("row-filter").value = "";
        openTable(row.dataset.table);
      }
    });

    $("row-filter").addEventListener("input", debounce(function (event) {
      state.query = event.target.value.trim();
      openTable(state.table, 1);
    }, 260));

    $("page-first").addEventListener("click", function () { openTable(state.table, 1); });
    $("page-prev").addEventListener("click", function () { openTable(state.table, state.page - 1); });
    $("page-next").addEventListener("click", function () { openTable(state.table, state.page + 1); });
    $("page-last").addEventListener("click", function () {
      openTable(state.table, (state.current && state.current.total_pages) || 1);
    });
    $("page-size").addEventListener("change", function (event) {
      state.pageSize = parseInt(event.target.value, 10);
      openTable(state.table, 1);
    });

    $("btn-structure").addEventListener("click", function () {
      renderStructure();
      showPane("structure");
    });
    $("btn-back-data").addEventListener("click", function () { showPane("data"); });

    $("struct").addEventListener("click", function (event) {
      var link = event.target.closest("[data-goto]");
      if (link) {
        state.query = "";
        $("row-filter").value = "";
        openTable(link.dataset.goto);
      }
    });

    $("erd-columns").addEventListener("change", erd.rerender);
    $("erd-linked").addEventListener("change", erd.rerender);
    $("erd-focus").addEventListener("input", debounce(function (event) {
      erd.focus(event.target.value.trim());
    }, 200));
    $("erd-in").addEventListener("click", function () { erd.zoomBy(1.2); });
    $("erd-out").addEventListener("click", function () { erd.zoomBy(1 / 1.2); });
    $("erd-fit").addEventListener("click", erd.fit);

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && state.table) {
        if ($("pane-structure").classList.contains("active")) showPane("data");
        else setView(state.view);
      }
    });
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    bind();
    renderCrumbs();
    await loadFiles();

    var route = readHash();
    var known = state.files.some(function (file) { return file.name === route.file; });
    if (route.file && known) {
      await selectFile(route.file);
      if (route.table === "~diagram") setView("diagram");
      else if (route.table) openTable(route.table);
    } else if (state.files.length === 1) {
      await selectFile(state.files[0].name);
    }
    state.booting = false;
  }

  boot();
})();
