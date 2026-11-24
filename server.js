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

function randomId() {
  return [...crypto.randomBytes(ID_LENGTH)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function createFileStore(file) {
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

  function change(id, state) {
    const previous = households.get(id);
    if (state) households.set(id, state);
    else households.delete(id);
    try {
      save();
    } catch (error) {
      if (previous) households.set(id, previous);
      else households.delete(id);
      throw error;
    }
  }

  return {
    label: `file ${file}`,
    async get(id) {
      return households.has(id) ? clone(households.get(id)) : null;
    },
    async create(id, state) {
      if (households.has(id)) return false;
      change(id, clone(state));
      return true;
    },
    async put(id, state) {
      change(id, clone(state));
    },
    async remove(id) {
      change(id, null);
    },
  };
}

function createRedisStore({ url, token, fetchImpl = fetch }) {
  const endpoint = url.replace(/\/+$/, "");
  const key = (id) => `chorequest:household:${id}`;

  async function command(...args) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(`Upstash ${args[0]} failed: ${data.error || response.status}`);
    return data.result;
  }

  return {
    label: "Upstash Redis",
    async get(id) {
      const raw = await command("GET", key(id));
      return raw ? CQ.normalize(JSON.parse(raw)) : null;
    },
    async create(id, state) {
      return (await command("SET", key(id), JSON.stringify(state), "NX")) === "OK";
    },
    async put(id, state) {
      await command("SET", key(id), JSON.stringify(state));
    },
    async remove(id) {
      await command("DEL", key(id));
    },
  };
}

function storeFromEnv(env = process.env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createRedisStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  }
  return createFileStore(env.DATA_FILE || path.join(ROOT, "data", "households.json"));
}

function createLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    blocked(key) {
      const entry = hits.get(key);
      return Boolean(entry) && entry.reset > Date.now() && entry.count >= limit;
    },
    hit(key) {
      const now = Date.now();
      if (hits.size > 10000) {
        for (const [name, entry] of hits) if (entry.reset <= now) hits.delete(name);
      }
      const entry = hits.get(key);
      if (!entry || entry.reset <= now) hits.set(key, { count: 1, reset: now + windowMs });
      else entry.count += 1;
    },
  };
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
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
  const store = options.store || createFileStore(options.dataFile || path.join(ROOT, "data", "households.json"));
  const clock = options.now || (() => new Date());
  const trustProxy = Boolean(options.trustProxy);
  const misses = createLimiter(options.missLimit || 20, 10 * 60 * 1000);
  const creates = createLimiter(options.createLimit || 10, 60 * 60 * 1000);
  const cache = new Map();
  const queues = new Map();

  function serial(id, task) {
    const run = (queues.get(id) || Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  async function save(id, state) {
    await store.put(id, state);
    cache.set(id, state);
  }

  async function current(id) {
    let state = cache.get(id);
    if (!state) {
      state = await store.get(id);
      if (!state) return null;
      cache.set(id, state);
    }
    const next = clone(state);
    if (CQ.refresh(next, clock())) {
      await save(id, next);
      return clone(next);
    }
    return next;
  }

  async function createHousehold(req, res, client) {
    if (creates.blocked(client)) {
      return send(res, 429, { error: "Too many new households from this network. Try again in an hour." });
    }
    const body = await readJson(req);
    const base = body.legacy ? CQ.normalize(body.legacy) : CQ.blankState();
    const result = CQ.applyHousehold(base, body.household || {}, clock());
    if (!result.ok) return send(res, 400, { error: result.error });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = randomId();
      if (cache.has(id) || !(await store.create(id, result.state))) continue;
      cache.set(id, result.state);
      creates.hit(client);
      return send(res, 201, { id, state: result.state });
    }
    throw new Error("Could not find a free household ID.");
  }

  async function handleApi(req, res, parts) {
    const client = clientKey(req, trustProxy);
    if (parts.length === 0) {
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
      return createHousehold(req, res, client);
    }

    const id = cleanId(parts[0]);
    if (!isId(id)) return send(res, 404, { error: "Household IDs are 6 letters and numbers." });
    if (misses.blocked(client)) {
      return send(res, 429, { error: "Too many wrong household IDs. Wait 10 minutes and try again." });
    }

    const isGet = parts.length === 1 && req.method === "GET";
    const isPut = parts.length === 1 && req.method === "PUT";
    const isDelete = parts.length === 1 && req.method === "DELETE";
    const isDone = parts.length === 2 && parts[1] === "done" && req.method === "POST";
    if (!isGet && !isPut && !isDelete && !isDone) return send(res, 405, { error: "Method not allowed." });
    const body = isPut || isDone ? await readJson(req) : {};

    return serial(id, async () => {
      const state = await current(id);
      if (!state) {
        misses.hit(client);
        return send(res, 404, { error: "No household has that ID." });
      }

      if (isGet) return send(res, 200, { id, state });

      if (isPut) {
        const result = CQ.applyHousehold(state, body.household || {}, clock());
        if (!result.ok) return send(res, 400, { error: result.error });
        await save(id, result.state);
        return send(res, 200, { id, state: result.state });
      }

      if (isDelete) {
        await store.remove(id);
        cache.delete(id);
        return send(res, 204);
      }

      if (!CQ.setDone(state, String(body.week || ""), String(body.choreId || ""), Boolean(body.done))) {
        return send(res, 409, { error: "That chore is no longer on the board.", id, state });
      }
      await save(id, state);
      return send(res, 200, { id, state });
    });
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
  const store = storeFromEnv();
  const trustProxy = Boolean(process.env.RENDER) || process.env.TRUST_PROXY === "1";
  const server = http.createServer(createApp({ store, trustProxy }));
  server.listen(port, host, () => {
    console.log("ChoreQuest is running.");
    console.log(`  Saving households in ${store.label}.`);
    console.log(`  Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    console.log(`  On this computer:   http://localhost:${port}`);
    for (const address of lanAddresses()) console.log(`  On the same Wi-Fi:  http://${address}:${port}`);
  });
}

module.exports = { createApp, createFileStore, createRedisStore, storeFromEnv, isId, cleanId, ID_LENGTH };
