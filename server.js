"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const CQ = require("./schedule.js");

const ROOT = __dirname;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ID_LENGTH = 6;
const MAX_BODY = 64 * 1024;
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/schedule.js": "schedule.js",
  "/styles.css": "styles.css",
};
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function cleanId(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isId(value) {
  return typeof value === "string" && value.length === ID_LENGTH && [...value].every((char) => ID_ALPHABET.includes(char));
}

function createStore(file) {
  const households = new Map();

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [id, state] of Object.entries(raw.households || {})) {
      if (isId(id)) households.set(id, CQ.normalize(state));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not read ${file}: ${error.message}`);
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ households: Object.fromEntries(households) }, null, 2));
    fs.renameSync(temp, file);
  }

  function newId() {
    for (;;) {
      const bytes = crypto.randomBytes(ID_LENGTH);
      const id = [...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
      if (!households.has(id)) return id;
    }
  }

  return { households, save, newId };
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("Request body is not valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const name = STATIC_FILES[pathname];
  if (!name || (req.method !== "GET" && req.method !== "HEAD")) return false;
  fs.readFile(path.join(ROOT, name), (error, data) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Could not read the file.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(name)],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
  return true;
}

function createApp(options = {}) {
  const store = createStore(options.dataFile || path.join(ROOT, "data", "households.json"));
  const clock = options.now || (() => new Date());

  function current(id) {
    const state = store.households.get(id);
    if (state && CQ.refresh(state, clock())) store.save();
    return state;
  }

  async function handleApi(req, res, parts) {
    if (parts.length === 0) {
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
      const body = await readJson(req);
      const base = body.legacy ? CQ.normalize(body.legacy) : CQ.blankState();
      const result = CQ.applyHousehold(base, body.household || {}, clock());
      if (!result.ok) return send(res, 400, { error: result.error });
      const id = store.newId();
      store.households.set(id, result.state);
      store.save();
      return send(res, 201, { id, state: result.state });
    }

    const id = cleanId(parts[0]);
    if (!isId(id)) return send(res, 404, { error: "Household IDs are 6 letters and numbers." });
    const state = current(id);
    if (!state) return send(res, 404, { error: "No household has that ID." });

    if (parts.length === 1 && req.method === "GET") return send(res, 200, { id, state });

    if (parts.length === 1 && req.method === "PUT") {
      const body = await readJson(req);
      const result = CQ.applyHousehold(state, body.household || {}, clock());
      if (!result.ok) return send(res, 400, { error: result.error });
      store.households.set(id, result.state);
      store.save();
      return send(res, 200, { id, state: result.state });
    }

    if (parts.length === 1 && req.method === "DELETE") {
      store.households.delete(id);
      store.save();
      return send(res, 204);
    }

    if (parts.length === 2 && parts[1] === "done" && req.method === "POST") {
      const body = await readJson(req);
      if (!CQ.setDone(state, String(body.week || ""), String(body.choreId || ""), Boolean(body.done))) {
        return send(res, 409, { error: "That chore is no longer on the board.", id, state });
      }
      store.save();
      return send(res, 200, { id, state });
    }

    return send(res, 405, { error: "Method not allowed." });
  }

  return function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/households" || pathname.startsWith("/api/households/")) {
      const parts = pathname.slice("/api/households".length).split("/").filter(Boolean);
      handleApi(req, res, parts).catch((error) => {
        if (res.headersSent) return;
        if (error.status) send(res, error.status, { error: error.message });
        else {
          console.error(error);
          send(res, 500, { error: "The server could not save that. Try again." });
        }
      });
      return;
    }
    if (serveStatic(req, res, pathname)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "0.0.0.0";
  const server = http.createServer(createApp({ dataFile: process.env.DATA_FILE }));
  server.listen(port, host, () => {
    console.log("ChoreQuest is running.");
    console.log(`  On this computer:   http://localhost:${port}`);
    for (const address of lanAddresses()) console.log(`  On the same Wi-Fi:  http://${address}:${port}`);
  });
}

module.exports = { createApp, isId, cleanId, ID_LENGTH };
