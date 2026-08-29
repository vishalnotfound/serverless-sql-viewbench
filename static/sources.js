/* Data sources.
 *
 * The UI talks to one interface and does not care where rows come from:
 *
 *   ServerSource  dumps stored in sql/, parsed by FastAPI
 *   LocalSource   a file on the user's machine, indexed by a Web Worker and
 *                 never uploaded
 *
 * Both expose: schema(), rows(), index(), cancel(), close().
 */
window.Sources = (function () {
  "use strict";

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        if (!response.ok) {
          throw new Error((body && body.detail) || response.statusText || "Request failed");
        }
        return body;
      });
    });
  }

  // ---------------------------------------------------------------- server

  function ServerSource(name) {
    this.kind = "server";
    this.name = name;
    this.size = null;
  }

  ServerSource.prototype.schema = function () {
    return request("/api/files/" + encodeURIComponent(this.name) + "/schema")
      .then(function (schema) {
        schema.partial = false;
        return schema;
      });
  };

  ServerSource.prototype.rows = function (table, page, pageSize, query) {
    var url = "/api/files/" + encodeURIComponent(this.name) +
      "/tables/" + encodeURIComponent(table) +
      "?page=" + page + "&page_size=" + pageSize +
      (query ? "&q=" + encodeURIComponent(query) : "");
    return request(url).then(function (payload) {
      payload.exact = true;                       // the server always counts
      payload.has_more = payload.page < payload.total_pages;
      payload.estimated_rows = null;
      return payload;
    });
  };

  ServerSource.prototype.index = function () { return Promise.resolve(null); };
  ServerSource.prototype.cancel = function () {};
  ServerSource.prototype.close = function () {};

  // ---------------------------------------------------------------- local

  function LocalSource(file, handlers) {
    var self = this;
    this.kind = "local";
    this.name = file.name;
    this.size = file.size;
    this.file = file;
    this.handlers = handlers || {};
    this.seq = 0;
    this.waiting = Object.create(null);
    this.worker = new Worker("/static/worker.js");

    this.worker.onmessage = function (event) { self.receive(event.data); };
    this.worker.onerror = function (event) {
      if (self.handlers.onError) self.handlers.onError(event.message || "Worker failed");
    };
  }

  LocalSource.prototype.receive = function (message) {
    if (message.t === "progress") {
      if (this.handlers.onProgress) this.handlers.onProgress(message.schema);
      return;
    }
    if (message.t === "indexProgress") {
      if (this.handlers.onIndexProgress) this.handlers.onIndexProgress(message);
      return;
    }
    if (message.t === "searchProgress") {
      if (this.handlers.onSearchProgress) this.handlers.onSearchProgress(message);
      return;
    }

    var pending = this.waiting[message.id];
    if (!pending) return;
    delete this.waiting[message.id];
    if (message.t === "error") pending.reject(new Error(message.message));
    else if (message.t === "schema") pending.resolve(message.schema);
    else if (message.t === "rows") pending.resolve(message.payload);
    else if (message.t === "indexed") pending.resolve(message);
  };

  LocalSource.prototype.send = function (message) {
    var self = this;
    message.id = ++this.seq;
    return new Promise(function (resolve, reject) {
      self.waiting[message.id] = { resolve: resolve, reject: reject };
      self.worker.postMessage(message);
    });
  };

  LocalSource.prototype.schema = function () {
    // The File is structured-cloned to the worker; its bytes stay on disk.
    return this.send({ t: "open", file: this.file });
  };

  LocalSource.prototype.rows = function (table, page, pageSize, query) {
    this.lastRowsId = this.seq + 1;
    return this.send({ t: "rows", table: table, page: page, pageSize: pageSize, query: query || "" });
  };

  LocalSource.prototype.index = function (table) {
    return this.send({ t: "index", table: table });
  };

  LocalSource.prototype.cancel = function () {
    if (this.lastRowsId) this.worker.postMessage({ t: "cancel", id: this.lastRowsId });
  };

  LocalSource.prototype.close = function () {
    this.worker.terminate();
  };

  return { ServerSource: ServerSource, LocalSource: LocalSource };
})();
