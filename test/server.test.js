const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createApp, createRedisStore, storeFromEnv, isId } = require("../server.js");

const household = {
  apartmentName: "Maple",
  roommates: [
    { id: "a", name: "Ari" },
    { id: "b", name: "Bea" },
  ],
  chores: [
    { id: "t", name: "Trash" },
    { id: "d", name: "Dishes" },
  ],
};

async function start(t, dataFile, extra = {}) {
  const now = () => new Date(2026, 10, 24, 12, 0, 0);
  const server = http.createServer(createApp({ dataFile, now, ...extra }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async function call(method, url, body) {
    const response = await fetch(base + url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, data: text && response.headers.get("content-type").includes("json") ? JSON.parse(text) : text };
  };
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chorequest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "households.json");
}

test("a household created on the server can be joined by its 6-character ID", async (t) => {
  const file = tempFile(t);
  const call = await start(t, file);

  const created = await call("POST", "/api/households", { household });
  assert.equal(created.status, 201);
  assert.equal(isId(created.data.id), true);
  assert.match(created.data.id, /^[A-Z0-9]{6}$/);
  assert.equal(created.data.state.apartmentName, "Maple");

  const joined = await call("GET", `/api/households/${created.data.id.toLowerCase()}`);
  assert.equal(joined.status, 200);
  assert.equal(joined.data.id, created.data.id);
  assert.deepEqual(joined.data.state.weeks["2026-11-22"].assignments.map((item) => item.roommateName), ["Ari", "Bea"]);

  const missing = await call("GET", "/api/households/ZZZZZZ");
  assert.equal(missing.status, 404);
  const malformed = await call("GET", "/api/households/abc");
  assert.equal(malformed.status, 404);

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(saved.households[created.data.id]);
});

test("check-offs and household edits are shared and survive a restart", async (t) => {
  const file = tempFile(t);
  const call = await start(t, file);
  const { data } = await call("POST", "/api/households", { household });
  const id = data.id;

  const marked = await call("POST", `/api/households/${id}/done`, { week: "2026-11-22", choreId: "t", done: true });
  assert.equal(marked.status, 200);
  const again = await call("POST", `/api/households/${id}/done`, { week: "2026-11-22", choreId: "t", done: true });
  assert.equal(again.data.state.weeks["2026-11-22"].assignments[0].done, true);

  const stale = await call("POST", `/api/households/${id}/done`, { week: "2026-11-22", choreId: "nope", done: true });
  assert.equal(stale.status, 409);
  const proto = await call("POST", `/api/households/${id}/done`, { week: "__proto__", choreId: "t", done: true });
  assert.equal(proto.status, 409);

  const edited = await call("PUT", `/api/households/${id}`, {
    household: { ...household, chores: [...household.chores, { id: "v", name: "Vacuum" }] },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.state.chores.length, 3);

  const rejected = await call("PUT", `/api/households/${id}`, { household: { ...household, chores: [] } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error, "Add at least one chore.");

  const restarted = await start(t, file);
  const reloaded = await restarted("GET", `/api/households/${id}`);
  assert.equal(reloaded.data.state.chores.length, 3);
  assert.equal(reloaded.data.state.weeks["2026-11-22"].assignments.find((item) => item.choreId === "t").done, true);

  assert.equal((await restarted("DELETE", `/api/households/${id}`)).status, 204);
  assert.equal((await restarted("GET", `/api/households/${id}`)).status, 404);
});

function fakeUpstash() {
  const data = new Map();
  const calls = [];
  async function fetchImpl(url, init) {
    assert.equal(url, "https://example.upstash.io");
    assert.equal(init.headers.Authorization, "Bearer secret");
    const [name, key, value, flag] = JSON.parse(init.body);
    calls.push(name);
    let result = null;
    if (name === "GET") result = data.has(key) ? data.get(key) : null;
    else if (name === "SET" && flag === "NX" && data.has(key)) result = null;
    else if (name === "SET") {
      data.set(key, value);
      result = "OK";
    } else if (name === "DEL") result = data.delete(key) ? 1 : 0;
    return { ok: true, json: async () => ({ result }) };
  }
  return { data, calls, store: createRedisStore({ url: "https://example.upstash.io/", token: "secret", fetchImpl }) };
}

test("households are saved in Upstash and reloaded by a fresh server", async (t) => {
  const upstash = fakeUpstash();
  const call = await start(t, tempFile(t), { store: upstash.store });
  const { data } = await call("POST", "/api/households", { household });
  assert.equal(upstash.data.has(`chorequest:household:${data.id}`), true);

  await call("POST", `/api/households/${data.id}/done`, { week: "2026-11-22", choreId: "d", done: true });
  const getsBefore = upstash.calls.filter((name) => name === "GET").length;
  await call("GET", `/api/households/${data.id}`);
  await call("GET", `/api/households/${data.id}`);
  assert.equal(upstash.calls.filter((name) => name === "GET").length, getsBefore);

  const restarted = await start(t, tempFile(t), { store: upstash.store });
  const reloaded = await restarted("GET", `/api/households/${data.id}`);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.data.state.weeks["2026-11-22"].assignments.find((item) => item.choreId === "d").done, true);

  assert.equal((await restarted("DELETE", `/api/households/${data.id}`)).status, 204);
  assert.equal(upstash.data.size, 0);
});

test("simultaneous check-offs on one household are all kept", async (t) => {
  const upstash = fakeUpstash();
  const call = await start(t, tempFile(t), { store: upstash.store });
  const { data } = await call("POST", "/api/households", { household });
  await Promise.all([
    call("POST", `/api/households/${data.id}/done`, { week: "2026-11-22", choreId: "t", done: true }),
    call("POST", `/api/households/${data.id}/done`, { week: "2026-11-22", choreId: "d", done: true }),
  ]);
  const saved = JSON.parse(upstash.data.get(`chorequest:household:${data.id}`));
  assert.deepEqual(saved.weeks["2026-11-22"].assignments.map((item) => item.done), [true, true]);
});

test("too many wrong IDs are blocked for a while", async (t) => {
  const call = await start(t, tempFile(t), { missLimit: 3 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await call("GET", "/api/households/ZZZZZZ")).status, 404);
  }
  const blocked = await call("GET", "/api/households/ZZZZZZ");
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /Too many wrong household IDs/);
});

test("the Upstash settings choose the database, otherwise the local file", () => {
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).label, "Upstash Redis");
  const fallback = storeFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", DATA_FILE: path.join(os.tmpdir(), "cq-none.json") });
  assert.match(fallback.label, /^file /);
});

test("only the app files are served", async (t) => {
  const call = await start(t, tempFile(t));
  assert.equal((await call("GET", "/")).status, 200);
  assert.equal((await call("GET", "/schedule.js")).status, 200);
  assert.equal((await call("GET", "/server.js")).status, 404);
  assert.equal((await call("GET", "/data/households.json")).status, 404);
  assert.equal((await call("GET", "/..%2fpackage.json")).status, 404);
  assert.equal((await call("POST", "/api/households", { household: { roommates: [], chores: [] } })).status, 400);
});
