// src/stats/cli.ts
import { resolve as resolve2 } from "node:path";

// src/stats/load.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as tick } from "node:timers/promises";
var CACHE_VERSION = 2;
var opaqueId = (value) => createHash("sha256").update(value).digest("hex");
var EXCLUDED_PROVIDERS = /* @__PURE__ */ new Set(["faux", "faux-provider", "fake-provider", "router"]);
var CHILD_NAME = /#[0-9a-f]{8}$/;
var LEADING_TIMESTAMP = /^.{0,200}?"timestamp"\s*:\s*"([^"]+)"/;
var YIELD_EVERY_LINES = 2e3;
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
function sessionsDir(dir = agentDir()) {
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(dir, "sessions");
}
function cachePath(dir = agentDir()) {
  return join(dir, "pi-session-kit", "stats-cache.json");
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function timeOf(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 && value <= 864e13 ? value : 0;
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
function looksLikeObject(line) {
  const text = line.trim();
  return text.startsWith("{") && text.endsWith("}");
}
var SessionParser = class {
  out;
  modelIndex = /* @__PURE__ */ new Map();
  parent = false;
  childName = false;
  markedChild = false;
  lines = 0;
  constructor(size, mtimeMs) {
    this.out = {
      size,
      mtimeMs,
      startMs: 0,
      endMs: 0,
      child: false,
      models: [],
      modelPairs: [],
      calls: [],
      entryIds: [],
      badLines: 0
    };
  }
  accept(line) {
    if (!line) return;
    const isHeader = this.lines++ === 0;
    const isAssistant = line.includes('"assistant"');
    const isInfo = line.includes('"session_info"') || line.includes('"session-kit:child"');
    if (!isHeader && !isAssistant && !isInfo) {
      if (!looksLikeObject(line)) this.out.badLines++;
      else this.seen(timeOf(LEADING_TIMESTAMP.exec(line)?.[1]));
      return;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      this.out.badLines++;
      return;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      this.out.badLines++;
      return;
    }
    const ts = timeOf(entry.timestamp);
    this.seen(ts);
    if (entry.type === "session") {
      if (typeof entry.id === "string" && entry.id) this.out.sessionId = opaqueId(`session:${entry.id}`);
      if (this.out.startMs === 0 || ts > 0 && ts < this.out.startMs) this.out.startMs = ts;
      if (typeof entry.parentSession === "string" && entry.parentSession) this.parent = true;
      return;
    }
    if (entry.type === "custom" && entry.customType === "session-kit:child") {
      const data = entry.data;
      if (data?.version === 1 && typeof data.sessionId === "string" && opaqueId(`session:${data.sessionId}`) === this.out.sessionId)
        this.markedChild = true;
      return;
    }
    if (entry.type === "session_info") {
      this.childName ||= typeof entry.name === "string" && CHILD_NAME.test(entry.name);
      return;
    }
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message?.role !== "assistant") return;
    this.call(message, ts, typeof entry.id === "string" && entry.id ? opaqueId(`entry:${entry.id}`) : null);
  }
  finish() {
    this.out.child = this.markedChild || this.parent && this.childName;
    return this.out;
  }
  seen(ts) {
    if (ts <= 0) return;
    if (this.out.startMs === 0) this.out.startMs = ts;
    if (ts > this.out.endMs) this.out.endMs = ts;
  }
  call(message, entryTs, entryId) {
    const provider = typeof message.provider === "string" ? message.provider : "";
    const model = typeof message.model === "string" ? message.model : "";
    if (!provider || !model || EXCLUDED_PROVIDERS.has(provider)) return;
    const usage = message.usage;
    if (!usage) return;
    if ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
      (v) => v !== void 0 && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    )) {
      this.out.badLines++;
      return;
    }
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheRead = num(usage.cacheRead);
    const cacheWrite = num(usage.cacheWrite);
    if (input + output + cacheRead + cacheWrite === 0) return;
    const costValue = usage.cost;
    const cost = typeof costValue === "number" ? num(costValue) : num(costValue?.total);
    if (cost < 0) {
      this.out.badLines++;
      return;
    }
    const ms = timeOf(message.timestamp) || entryTs;
    if (ms <= 0) return;
    const name2 = JSON.stringify([provider, model]);
    let index = this.modelIndex.get(name2);
    if (index === void 0) {
      index = this.out.models.length;
      this.out.models.push(`${provider}/${model}`);
      this.out.modelPairs?.push([provider, model]);
      this.modelIndex.set(name2, index);
    }
    this.out.calls.push([ms, index, input, output, cacheRead, cacheWrite, cost]);
    this.out.entryIds?.push(entryId);
  }
};
async function parseFile(path, size, mtimeMs) {
  const parser = new SessionParser(size, mtimeMs);
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });
  let n = 0;
  for await (const line of rl) {
    parser.accept(line);
    if (++n % YIELD_EVERY_LINES === 0) await tick();
  }
  return parser.finish();
}
async function listJsonl(root) {
  const out = [];
  let errors = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!(dir === root && error.code === "ENOENT")) errors++;
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  await walk(root);
  return { paths: out.sort(), errors };
}
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
function isFileStats(value) {
  if (typeof value !== "object" || value === null) return false;
  const f = value;
  if (!isNum(f.size) || !isNum(f.mtimeMs) || !isNum(f.startMs) || !isNum(f.endMs) || !isNum(f.badLines)) return false;
  if (typeof f.child !== "boolean") return false;
  if (f.sessionId !== void 0 && (typeof f.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(f.sessionId)))
    return false;
  if (f.entryIds !== void 0 && (!Array.isArray(f.entryIds) || !Array.isArray(f.calls) || f.entryIds.length !== f.calls.length || !f.entryIds.every((id) => id === null || typeof id === "string" && /^[a-f0-9]{64}$/.test(id))))
    return false;
  const models = f.models;
  if (!Array.isArray(models) || !models.every((m) => typeof m === "string" && m.includes("/"))) return false;
  if (f.modelPairs !== void 0 && (!Array.isArray(f.modelPairs) || f.modelPairs.length !== models.length || !f.modelPairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "string"))))
    return false;
  return Array.isArray(f.calls) && f.calls.every(
    (c) => Array.isArray(c) && c.length === 7 && c.every(isNum) && Number.isInteger(c[1]) && c[1] >= 0 && c[1] < models.length
  );
}
async function readCache(path) {
  let doc;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { files: {}, migrate: false };
  }
  if (doc?.version !== CACHE_VERSION && doc?.version !== 1 || typeof doc.files !== "object" || doc.files === null)
    return { files: {}, migrate: false };
  return {
    files: Object.fromEntries(Object.entries(doc.files).filter(([, record2]) => isFileStats(record2))),
    migrate: doc.version === 1
  };
}
async function writeCache(path, files) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files }));
  await rename(tmp, path);
}
function legacyKey(c) {
  return JSON.stringify([c.provider, c.model, c.ms, c.input, c.output, c.cacheRead, c.cacheWrite]);
}
function dedupCalls(candidates) {
  const identified = new Set(candidates.filter((c) => c.entryId).map(legacyKey));
  const seen = /* @__PURE__ */ new Set();
  return [...candidates].sort((a, b) => a.ms - b.ms).filter((c) => {
    const legacy = legacyKey(c);
    if (!c.entryId && identified.has(legacy)) return false;
    const key = c.entryId ? JSON.stringify([c.entryId, legacy]) : legacy;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function loadUsage(options = {}) {
  const root = resolve(options.root ?? sessionsDir());
  const cacheFile = options.cache ?? cachePath();
  const { files, migrate } = await readCache(cacheFile);
  const listed = await listJsonl(root);
  const paths = listed.paths;
  let errors = listed.errors;
  const stale = [];
  for (const path of paths) {
    try {
      const s = await stat(path);
      const hit = files[path];
      if (!hit || hit.entryIds === void 0 || hit.size !== s.size || hit.mtimeMs !== s.mtimeMs)
        stale.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      errors++;
    }
  }
  let done = 0;
  let dirty = migrate;
  for (const { path, size, mtimeMs } of stale) {
    try {
      files[path] = await parseFile(path, size, mtimeMs);
      dirty = true;
    } catch {
      errors++;
    }
    options.onProgress?.(++done, stale.length);
  }
  if (dirty) {
    try {
      await writeCache(cacheFile, files);
    } catch {
      errors++;
    }
  }
  const prefix = `${resolve(root)}${sep}`;
  const scoped = Object.fromEntries(
    Object.entries(files).filter(([path]) => options.includeAllRoots || path.startsWith(prefix))
  );
  return { ...flatten(scoped), errors };
}
function mergeSessionMetadata(sessions) {
  const metadata = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const old = metadata.get(session.path);
    metadata.set(session.path, {
      ...session,
      startMs: Math.min(session.startMs, old?.startMs ?? session.startMs),
      endMs: Math.max(session.endMs, old?.endMs ?? session.endMs),
      child: session.child || old?.child || false
    });
  }
  return metadata;
}
function flatten(files) {
  const sessions = [];
  const candidates = [];
  let badLines = 0;
  const ordered = Object.entries(files).sort(([pa, a], [pb, b]) => a.startMs - b.startMs || pa.localeCompare(pb));
  for (const [path, file] of ordered) {
    badLines += file.badLines ?? 0;
    const session = file.sessionId ?? opaqueId(`legacy-session:${path}`);
    for (const [i, tuple] of file.calls.entries()) {
      const [ms, index, input, output, cacheRead, cacheWrite, cost] = tuple;
      const raw = file.models[index] ?? "unknown/unknown";
      const slash = raw.indexOf("/");
      candidates.push({
        session,
        entryId: file.entryIds?.[i] ?? void 0,
        ms,
        provider: file.modelPairs?.[index]?.[0] ?? raw.slice(0, slash),
        model: file.modelPairs?.[index]?.[1] ?? raw.slice(slash + 1),
        input,
        output,
        cacheRead,
        cacheWrite,
        cost
      });
    }
    if (file.calls.length > 0)
      sessions.push({ path: session, startMs: file.startMs, endMs: file.endMs, child: file.child });
  }
  const calls = dedupCalls(candidates);
  const owners = new Set(calls.map((c) => c.session));
  const metadata = mergeSessionMetadata(sessions);
  return {
    calls,
    sessionMetadata: [...metadata.values()],
    sessions: [...metadata.values()].filter((s) => !s.child && owners.has(s.path)),
    badLines
  };
}

// src/stats/snapshot.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { link, lstat, mkdir as mkdir2, readdir as readdir2, readFile as readFile2, rename as rename2, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
var SNAPSHOT_VERSION = 1;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var HASH = /^[a-f0-9]{64}$/;
var MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
var MAX_BYTES = 128 * 1024 * 1024;
async function atomicJson(path, value) {
  await mkdir2(dirname2(path), { recursive: true });
  const tmp = `${path}.${randomUUID2()}.tmp`;
  try {
    await writeFile2(tmp, JSON.stringify(value), { mode: 384 });
    await rename2(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {
    });
    throw error;
  }
}
var record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function exact(v, keys) {
  if (!record(v) || Object.keys(v).length !== keys.length || !Object.keys(v).every((key) => keys.includes(key)))
    throw new Error("Unexpected snapshot fields");
}
var positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 864e13;
var count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
var hash = (v) => typeof v === "string" && HASH.test(v);
var name = (v) => typeof v === "string" && v.length > 0 && v.length <= 1024;
var monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
function validateIdentity(value) {
  exact(value, ["machineId", "label"]);
  if (typeof value.machineId !== "string" || !UUID.test(value.machineId) || !name(value.label))
    throw new Error("Invalid installation identity");
  return value;
}
async function machineIdentity(dir = agentDir()) {
  const path = join2(dir, "pi-session-kit", "machine.json");
  try {
    return validateIdentity(await jsonFile(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir2(dirname2(path), { recursive: true });
  const identity = { machineId: randomUUID2(), label: "Pi machine" };
  const tmp = `${path}.${randomUUID2()}.tmp`;
  await writeFile2(tmp, JSON.stringify(identity), { flag: "wx", mode: 384 });
  try {
    await link(tmp, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(tmp);
  }
  return validateIdentity(await jsonFile(path));
}
function eventId(event) {
  if (event.entryId === null)
    return opaqueId(
      JSON.stringify([
        event.provider,
        event.model,
        event.ms,
        event.input,
        event.output,
        event.cacheRead,
        event.cacheWrite
      ])
    );
  return opaqueId(
    JSON.stringify([
      event.entryId,
      event.ms,
      event.provider,
      event.model,
      event.input,
      event.output,
      event.cacheRead,
      event.cacheWrite
    ])
  );
}
function makeSnapshot(loaded, identity, exportedAt = Date.now()) {
  const shards = /* @__PURE__ */ new Map();
  const shard = (month) => {
    let s = shards.get(month);
    if (!s) {
      s = { version: SNAPSHOT_VERSION, machineId: identity.machineId, month, events: [], sessions: [] };
      shards.set(month, s);
    }
    return s;
  };
  const sessionId = (value) => HASH.test(value) ? value : opaqueId(`session:${value}`);
  for (const c of loaded.calls) {
    const e = {
      entryId: c.entryId ?? null,
      sessionId: sessionId(c.session),
      ms: c.ms,
      provider: c.provider,
      model: c.model,
      input: c.input,
      output: c.output,
      cacheRead: c.cacheRead,
      cacheWrite: c.cacheWrite,
      cost: c.cost
    };
    shard(monthOf(c.ms)).events.push({ id: eventId(e), ...e });
  }
  for (const s of loaded.sessionMetadata ?? loaded.sessions)
    shard(monthOf(s.startMs)).sessions.push({
      id: sessionId(s.path),
      startMs: s.startMs,
      endMs: s.endMs,
      child: s.child ?? false
    });
  return {
    manifest: {
      version: SNAPSHOT_VERSION,
      machineId: identity.machineId,
      label: identity.label,
      exportedAt,
      shards: []
    },
    shards: [...shards.values()].sort((a, b) => a.month.localeCompare(b.month))
  };
}
function validateManifest(value) {
  exact(value, ["version", "machineId", "label", "exportedAt", "shards"]);
  if (value.version !== SNAPSHOT_VERSION || typeof value.machineId !== "string" || !UUID.test(value.machineId) || !name(value.label) || !positive(value.exportedAt) || !Array.isArray(value.shards))
    throw new Error("Invalid or unsupported manifest");
  const months = /* @__PURE__ */ new Set();
  for (const ref of value.shards) {
    exact(ref, ["month", "file", "sha256", "bytes"]);
    if (typeof ref.month !== "string" || !MONTH.test(ref.month) || months.has(ref.month) || !hash(ref.sha256) || ref.file !== `${ref.month}-${ref.sha256}.json` || !count(ref.bytes) || ref.bytes > MAX_BYTES)
      throw new Error("Invalid shard reference");
    months.add(ref.month);
  }
  return value;
}
function validateShard(value, manifest, month) {
  exact(value, ["version", "machineId", "month", "events", "sessions"]);
  if (value.version !== SNAPSHOT_VERSION || value.machineId !== manifest.machineId || value.month !== month || !Array.isArray(value.events) || !Array.isArray(value.sessions))
    throw new Error("Invalid shard header");
  const seenEvents = /* @__PURE__ */ new Set();
  for (const e of value.events) {
    exact(e, [
      "id",
      "entryId",
      "sessionId",
      "ms",
      "provider",
      "model",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cost"
    ]);
    if (!hash(e.id) || seenEvents.has(e.id) || !(e.entryId === null || hash(e.entryId)) || !hash(e.sessionId) || !positive(e.ms) || monthOf(e.ms) !== month || !name(e.provider) || !name(e.model) || ["router", "faux", "faux-provider", "fake-provider"].includes(e.provider) || ![e.input, e.output, e.cacheRead, e.cacheWrite].every(count) || e.input + e.output + e.cacheRead + e.cacheWrite === 0 || typeof e.cost !== "number" || !Number.isFinite(e.cost) || e.cost < 0 || eventId(e) !== e.id)
      throw new Error("Invalid snapshot event");
    seenEvents.add(e.id);
  }
  const seenSessions = /* @__PURE__ */ new Set();
  for (const s of value.sessions) {
    exact(s, ["id", "startMs", "endMs", "child"]);
    if (!hash(s.id) || seenSessions.has(s.id) || !positive(s.startMs) || !positive(s.endMs) || s.endMs < s.startMs || monthOf(s.startMs) !== month || typeof s.child !== "boolean")
      throw new Error("Invalid snapshot session");
    seenSessions.add(s.id);
  }
  return value;
}
function validateSnapshot(snapshot) {
  const metadata = /* @__PURE__ */ new Set();
  const events = /* @__PURE__ */ new Set();
  for (const s of snapshot.shards) {
    for (const session of s.sessions) {
      if (metadata.has(session.id)) throw new Error("Duplicate session metadata");
      metadata.add(session.id);
    }
    for (const e of s.events) {
      if (events.has(e.id)) throw new Error("Duplicate event identity");
      events.add(e.id);
    }
  }
  for (const s of snapshot.shards)
    for (const e of s.events) if (!metadata.has(e.sessionId)) throw new Error("Missing session metadata");
}
async function exportStats(dir, output, root = sessionsDir(dir)) {
  const identity = await machineIdentity(dir);
  const loaded = await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true });
  if (loaded.errors || loaded.badLines)
    throw new Error(`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`);
  const snapshot = makeSnapshot(loaded, identity);
  validateSnapshot(snapshot);
  const snapshotDir = join2(output, "machines", identity.machineId);
  await mkdir2(snapshotDir, { recursive: true });
  for (const s of snapshot.shards) {
    const text = JSON.stringify(s);
    const sha256 = opaqueId(text);
    const file = `${s.month}-${sha256}.json`;
    validateShard(s, snapshot.manifest, s.month);
    await atomicJson(join2(snapshotDir, file), s);
    snapshot.manifest.shards.push({ month: s.month, file, sha256, bytes: Buffer.byteLength(text) });
  }
  await atomicJson(join2(snapshotDir, "manifest.json"), validateManifest(snapshot.manifest));
  return { machineId: identity.machineId, snapshotDir };
}
var globalPath = (dir) => join2(dir, "pi-session-kit", "stats-global.json");
async function jsonFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Not a bounded regular snapshot file");
  return JSON.parse(await readFile2(path, "utf8"));
}
async function readGlobal(dir) {
  const empty = { version: SNAPSHOT_VERSION, importedAt: 0, machines: {}, problems: [] };
  try {
    const v = await jsonFile(globalPath(dir));
    exact(v, ["version", "importedAt", "machines", "problems"]);
    if (v.version !== SNAPSHOT_VERSION || !count(v.importedAt) || !record(v.machines) || !Array.isArray(v.problems) || !v.problems.every((p) => typeof p === "string"))
      throw new Error("Invalid global cache");
    for (const [id, machine] of Object.entries(v.machines)) {
      exact(machine, ["manifest", "shards"]);
      const m = validateManifest(machine.manifest);
      if (m.machineId !== id || !Array.isArray(machine.shards) || machine.shards.length !== m.shards.length)
        throw new Error("Invalid cached machine");
      for (const [i, s] of machine.shards.entries()) {
        const ref = m.shards[i];
        if (!ref) throw new Error("Missing shard");
        validateShard(s, m, ref.month);
        if (opaqueId(JSON.stringify(s)) !== ref.sha256) throw new Error("Cached shard digest mismatch");
      }
      validateSnapshot(machine);
    }
    return v;
  } catch (error) {
    if (error.code === "ENOENT") return empty;
    return { ...empty, problems: ["Unreadable global cache"] };
  }
}
async function importStats(dir, input) {
  const previous = await readGlobal(dir);
  const machines = { ...previous.machines };
  const problems = [];
  let imported = 0;
  const present = /* @__PURE__ */ new Set();
  try {
    for (const entry of await readdir2(join2(input, "machines"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) {
        problems.push("Invalid machine directory");
        continue;
      }
      const id = entry.name;
      present.add(id);
      try {
        const base = join2(input, "machines", id);
        const manifest = validateManifest(await jsonFile(join2(base, "manifest.json")));
        if (manifest.machineId !== id) throw new Error("Machine identity mismatch");
        const shards = [];
        for (const ref of manifest.shards) {
          const path = join2(base, ref.file);
          const info = await lstat(path);
          if (!info.isFile() || info.size !== ref.bytes || info.size > MAX_BYTES)
            throw new Error("Invalid shard size/type");
          const text = await readFile2(path, "utf8");
          if (opaqueId(text) !== ref.sha256) throw new Error("Shard digest mismatch");
          const s = validateShard(JSON.parse(text), manifest, ref.month);
          if (JSON.stringify(s) !== text) throw new Error("Noncanonical shard JSON");
          shards.push(s);
        }
        validateSnapshot({ manifest, shards });
        if (machines[id] && manifest.exportedAt < (machines[id]?.manifest.exportedAt ?? 0))
          throw new Error("Older machine snapshot");
        machines[id] = { manifest, shards };
        imported++;
      } catch {
        problems.push(`Incomplete snapshot ${id}`);
      }
    }
  } catch {
    problems.push("Unreadable machines directory");
  }
  for (const id of Object.keys(previous.machines)) if (!present.has(id)) problems.push(`Missing snapshot ${id}`);
  const importedAt = imported > 0 ? Date.now() : previous.importedAt;
  const next = { version: SNAPSHOT_VERSION, importedAt, machines, problems };
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES)
    throw new Error("Global cache exceeds 128 MiB; last-good cache retained");
  await atomicJson(globalPath(dir), next);
  return { imported, retained: Object.keys(machines).length - imported, problems, importedAt };
}

// src/stats/cli.ts
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = /* @__PURE__ */ new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !value || value.startsWith("--") || options.has(flag) || !["--agent-dir", "--output", "--input", "--sessions-dir"].includes(flag))
      throw new Error(
        "usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] | import --agent-dir DIR --input REPO"
      );
    options.set(flag, value);
  }
  const dir = resolve2(options.get("--agent-dir") ?? agentDir());
  if (command === "export" && options.has("--output") && !options.has("--input")) {
    const root = options.get("--sessions-dir");
    console.log(
      JSON.stringify(await exportStats(dir, resolve2(options.get("--output") ?? ""), root ? resolve2(root) : void 0))
    );
  } else if (command === "import" && options.has("--input") && !options.has("--output") && !options.has("--sessions-dir")) {
    const result = await importStats(dir, resolve2(options.get("--input") ?? ""));
    console.log(JSON.stringify(result));
    if (result.problems.length) {
      console.error(result.problems.join("\n"));
      process.exitCode = 1;
    }
  } else
    throw new Error(
      "usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] | import --agent-dir DIR --input REPO"
    );
}
async function run() {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Stats operation failed");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) void run();
export {
  main,
  run
};
