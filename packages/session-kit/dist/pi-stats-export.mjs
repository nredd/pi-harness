// src/stats/cli.ts
import { realpathSync } from "node:fs";
import { resolve as resolve3 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// src/agent-dir.ts
import { homedir } from "node:os";
import { join } from "node:path";
function agentDir(homeDir = homedir()) {
  return process.env.PI_CODING_AGENT_DIR ?? join(homeDir, ".pi", "agent");
}

// src/stats/load.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join as join3, resolve, sep } from "node:path";

// src/stats/jsonl.ts
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join as join2 } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as tick } from "node:timers/promises";
var YIELD_EVERY_LINES = 2e3;
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
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
var NUL_PADDING = /^\0+$/;
async function feedFile(path, parser) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });
  let n = 0;
  for await (const line of rl) {
    parser.accept(line);
    if (++n % YIELD_EVERY_LINES === 0) await tick();
  }
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
      const path = join2(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  await walk(root);
  return { paths: out.sort(), errors };
}

// src/stats/nth.ts
function nth(items, index) {
  return items[index];
}

// src/stats/load.ts
var CACHE_VERSION = 3;
var opaqueId = (value) => createHash("sha256").update(value).digest("hex");
var EXCLUDED_PROVIDERS = /* @__PURE__ */ new Set(["faux", "faux-provider", "fake-provider", "router"]);
var CHILD_NAME = /#[0-9a-f]{8}$/;
var LEADING_TIMESTAMP = /^.{0,200}?"timestamp"\s*:\s*"([^"]+)"/;
var HARNESSES = ["pi", "claude", "codex", "opencode"];
function sessionsDir(dir = agentDir()) {
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join3(dir, "sessions");
}
function cachePath(dir = agentDir()) {
  return join3(dir, "pi-session-kit", "stats-cache.json");
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
    if (!line || NUL_PADDING.test(line)) return;
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
  await feedFile(path, parser);
  return parser.finish();
}
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
  if (doc?.version !== CACHE_VERSION && doc?.version !== 1 && doc?.version !== 2 || typeof doc.files !== "object" || doc.files === null)
    return { files: {}, migrate: false };
  const current = doc.version === CACHE_VERSION;
  const files = {};
  for (const [file, record2] of Object.entries(doc.files)) {
    if (!isFileStats(record2)) continue;
    files[file] = !current && record2.badLines > 0 ? { ...record2, size: -1 } : record2;
  }
  return { files, migrate: !current };
}
async function writeCache(path, files) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files }));
  await rename(tmp, path);
}
function legacyKey(c) {
  return JSON.stringify([c.harness, c.provider, c.model, c.ms, c.input, c.output, c.cacheRead, c.cacheWrite]);
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
    badLines += file.badLines;
    const session = file.sessionId ?? opaqueId(`legacy-session:${path}`);
    for (const [i, tuple] of file.calls.entries()) {
      const [ms, index, input, output, cacheRead, cacheWrite, cost] = tuple;
      const raw = nth(file.models, index);
      const slash = raw.indexOf("/");
      candidates.push({
        harness: "pi",
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
import { randomUUID as randomUUID3 } from "node:crypto";
import { link, lstat, mkdir as mkdir3, readdir as readdir2, readFile as readFile3, rename as rename3, unlink, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname3, join as join7 } from "node:path";

// src/stats/harness/common.ts
function mergeQuota(readings) {
  const best = /* @__PURE__ */ new Map();
  for (const q of readings) {
    const key = JSON.stringify([q.provider, q.limitId, q.window]);
    const prev = best.get(key);
    if (!prev || q.observedAt > prev.observedAt || q.observedAt === prev.observedAt && JSON.stringify(q) > JSON.stringify(prev))
      best.set(key, q);
  }
  return [...best.values()];
}
var emptyScan = (found, problems = []) => ({
  found,
  calls: [],
  sessions: [],
  sessionMetadata: [],
  quota: [],
  problems
});
var entryHash = (harness, native) => opaqueId(`${harness}:${native}`);
var sessionHash = (harness, native) => opaqueId(`${harness}-session:${native}`);
var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var asRecordOf = (value) => asRecord(value) ?? {};
var str = (value) => typeof value === "string" ? value : "";
function counters(values) {
  const out = [];
  for (const v of values) {
    if (v === void 0 || v === null) out.push(0);
    else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out.push(v);
    else return null;
  }
  return out;
}
var anyPresent = (values) => values.some((v) => v !== void 0 && v !== null);
var windowName = (seconds) => seconds === 604800 ? "7d" : seconds === 18e3 ? "5h" : `${seconds}s`;
var unreadable = (harness, n) => n > 0 ? [`${harness}: ! ${n} unreadable lines`] : [];

// src/stats/harness/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join6 } from "node:path";

// src/stats/harness/claude.ts
import { basename, join as join4, sep as sep3 } from "node:path";

// src/stats/harness/scan.ts
import { stat as stat2 } from "node:fs/promises";
import { resolve as resolve2, sep as sep2 } from "node:path";
var RowParser = class {
  out;
  modelIndex = /* @__PURE__ */ new Map();
  constructor(size, mtimeMs) {
    this.out = {
      size,
      mtimeMs,
      startMs: 0,
      endMs: 0,
      session: "",
      child: false,
      models: [],
      calls: [],
      entryIds: [],
      quota: [],
      badLines: 0,
      unsupportedTurns: 0
    };
  }
  accept(line) {
    if (!line || NUL_PADDING.test(line)) return;
    if (!this.wanted(line)) {
      if (!looksLikeObject(line)) this.out.badLines++;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.out.badLines++;
      return;
    }
    const row = asRecord(parsed);
    if (!row) {
      this.out.badLines++;
      return;
    }
    this.row(row, timeOf(row.timestamp));
  }
  finish() {
    return this.out;
  }
  /** Extend the file's time span. Callers pass a validated positive timestamp. */
  seen(ts) {
    if (this.out.startMs === 0 || ts < this.out.startMs) this.out.startMs = ts;
    if (ts > this.out.endMs) this.out.endMs = ts;
  }
  addCall(provider, model, ms, counts, cost, entryId) {
    const name2 = JSON.stringify([provider, model]);
    let index = this.modelIndex.get(name2);
    if (index === void 0) {
      index = this.out.models.length;
      this.out.models.push([provider, model]);
      this.modelIndex.set(name2, index);
    }
    this.out.calls.push([ms, index, nth(counts, 0), nth(counts, 1), nth(counts, 2), nth(counts, 3), cost]);
    this.out.entryIds.push(entryId);
  }
};
var isHash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
var isQuota = (q) => {
  const r = asRecordOf(q);
  return typeof r.harness === "string" && [r.provider, r.limitId, r.window].every((v) => typeof v === "string") && [r.usedPercent, r.resetAt, r.durationMs, r.observedAt].every(isNum) && (r.planType === null || typeof r.planType === "string");
};
function isParsedFile(value) {
  const f = asRecordOf(value);
  const { models, calls, entryIds, quota } = f;
  return [f.size, f.mtimeMs, f.startMs, f.endMs, f.badLines, f.unsupportedTurns].every(isNum) && typeof f.session === "string" && typeof f.child === "boolean" && Array.isArray(models) && models.every((m) => Array.isArray(m) && m.length === 2 && m.every((n) => typeof n === "string")) && Array.isArray(calls) && calls.every(
    (c) => Array.isArray(c) && c.length === 7 && c.slice(0, 6).every(isNum) && (c[6] === null || isNum(c[6])) && Number.isInteger(c[1]) && nth(c, 1) >= 0 && nth(c, 1) < models.length
  ) && Array.isArray(entryIds) && entryIds.length === calls.length && entryIds.every(isHash) && Array.isArray(quota) && quota.every(isQuota);
}
async function isDirectory(path) {
  try {
    return (await stat2(path)).isDirectory();
  } catch {
    return false;
  }
}
async function scanJsonl(options) {
  const { harness, cache } = options;
  const root = resolve2(options.root);
  if (!await isDirectory(root)) return emptyScan(false);
  const files = cache[harness] ?? {};
  cache[harness] = files;
  let errors = 0;
  for (const dir of options.dirs) {
    const listed = await listJsonl(resolve2(dir));
    errors += listed.errors;
    for (const path of listed.paths) {
      try {
        const s = await stat2(path);
        const hit = files[path];
        if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) continue;
        const parser = options.parser(path, s.size, s.mtimeMs);
        await feedFile(path, parser);
        files[path] = parser.finish();
      } catch {
        errors++;
      }
    }
  }
  const prefix = `${root}${sep2}`;
  const scoped = Object.entries(files).filter(([path]) => path.startsWith(prefix));
  const out = flattenHarness(harness, scoped);
  const problems = [
    ...errors > 0 ? [`${harness}: ${errors} unreadable files`] : [],
    ...unreadable(harness, out.badLines),
    ...out.unsupportedTurns > 0 ? [`${harness}: ${out.unsupportedTurns} turns skipped, no per-turn usage records`] : []
  ];
  return {
    found: true,
    calls: out.calls,
    sessions: out.sessions,
    sessionMetadata: out.sessionMetadata,
    quota: out.quota,
    problems
  };
}
function flattenHarness(harness, files) {
  const ordered = [...files].sort(([pa, a], [pb, b]) => a.startMs - b.startMs || pa.localeCompare(pb));
  const best = /* @__PURE__ */ new Map();
  const sessions = [];
  const quota = [];
  let badLines = 0;
  let unsupportedTurns = 0;
  for (const [, file] of ordered) {
    badLines += file.badLines;
    unsupportedTurns += file.unsupportedTurns;
    for (const [i, tuple] of file.calls.entries()) {
      const [ms, index, input, output, cacheRead, cacheWrite, cost] = tuple;
      const entryId = file.entryIds[i];
      const [provider, model] = file.models[index];
      const kept = best.get(entryId);
      if (kept && kept.output >= output) continue;
      best.set(entryId, {
        harness,
        session: file.session,
        entryId,
        ms,
        provider,
        model,
        input,
        output,
        cacheRead,
        cacheWrite,
        cost
      });
    }
    if (file.calls.length > 0)
      sessions.push({ path: file.session, startMs: file.startMs, endMs: file.endMs, child: file.child });
    quota.push(...file.quota);
  }
  const calls = [...best.values()].sort((a, b) => a.ms - b.ms);
  const owners = new Set(calls.map((c) => c.session));
  const metadata = mergeSessionMetadata(sessions);
  return {
    calls,
    sessionMetadata: [...metadata.values()],
    sessions: [...metadata.values()].filter((s) => !s.child && owners.has(s.path)),
    quota: mergeQuota(quota),
    badLines,
    unsupportedTurns
  };
}

// src/stats/harness/claude.ts
var SYNTHETIC_MODEL = "<synthetic>";
var ClaudeParser = class extends RowParser {
  agent;
  constructor(size, mtimeMs, agent) {
    super(size, mtimeMs);
    this.agent = agent;
    this.out.child = agent !== null;
  }
  wanted(line) {
    return line.includes('"assistant"');
  }
  row(row, ts) {
    if (row.type !== "assistant") return;
    const message = asRecord(row.message);
    const usage = asRecord(message?.usage);
    const model = str(message?.model);
    if (!usage || !model || model === SYNTHETIC_MODEL) return;
    const raw = [
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens
    ];
    const counts = counters(raw);
    if (!counts || !anyPresent(raw)) {
      this.out.badLines++;
      return;
    }
    if (counts.every((n) => n === 0)) return;
    const [id, requestId, sessionId] = [str(message?.id), str(row.requestId), str(row.sessionId)];
    if (!id || !requestId || !sessionId || ts <= 0) {
      this.out.badLines++;
      return;
    }
    this.seen(ts);
    this.out.session ||= sessionHash("claude", this.agent === null ? sessionId : `${sessionId}#${this.agent}`);
    this.addCall("anthropic", model, ts, counts, null, entryHash("claude", JSON.stringify([id, requestId])));
  }
};
var agentOf = (path) => path.split(sep3).at(-2) === "subagents" ? basename(path, ".jsonl") : null;
async function readClaude(root, cache) {
  return scanJsonl({
    harness: "claude",
    root,
    dirs: [join4(root, "projects")],
    cache,
    parser: (path, size, mtimeMs) => new ClaudeParser(size, mtimeMs, agentOf(path))
  });
}

// src/stats/harness/codex.ts
import { join as join5 } from "node:path";
var QUOTA_PROVIDER = "openai-codex";
var FALLBACK_PROVIDER = "openai";
var CodexParser = class extends RowParser {
  provider = "";
  turnModels = /* @__PURE__ */ new Map();
  pending = [];
  quota = /* @__PURE__ */ new Map();
  currentTurn = "";
  countedTurns = /* @__PURE__ */ new Set();
  recordedTurns = /* @__PURE__ */ new Set();
  wanted(line) {
    return ["session_meta", "turn_context", "token_usage_record", "token_count"].some((t) => line.includes(t));
  }
  row(row, ts) {
    const payload = asRecordOf(row.payload);
    if (row.type === "session_meta") {
      const id = str(payload.id);
      if (id && !this.out.session) {
        this.out.session = sessionHash("codex", id);
        this.out.child = str(payload.parent_thread_id) !== "" || str(payload.agent_path) !== "";
        this.provider = str(payload.model_provider);
      }
    } else if (row.type === "turn_context") {
      this.currentTurn = str(payload.turn_id);
      this.turnModels.set(this.currentTurn, str(payload.model));
    } else if (row.type === "token_usage_record") {
      this.usage(payload, ts);
    } else if (row.type === "event_msg" && payload.type === "token_count") {
      if (asRecord(payload.info)) this.countedTurns.add(this.currentTurn);
      this.limits(asRecord(payload.rate_limits), ts);
    }
  }
  usage(payload, ts) {
    this.recordedTurns.add(str(payload.turn_id));
    const usage = asRecord(payload.usage);
    const raw = [
      usage?.input_tokens,
      usage?.cached_input_tokens,
      usage?.cache_write_input_tokens,
      usage?.output_tokens
    ];
    const counts = counters(raw);
    const [responseId, turnId] = [str(payload.response_id), str(payload.turn_id)];
    if (!counts || !anyPresent(raw) || !responseId || !turnId || ts <= 0) {
      this.out.badLines++;
      return;
    }
    const [input, cached, written, output] = counts;
    if (input + output === 0) return;
    this.seen(ts);
    this.pending.push({
      ms: ts,
      turnId,
      responseId,
      counts: [Math.max(0, input - cached - written), output, cached, written]
    });
  }
  limits(limits, ts) {
    const limitId = str(limits?.limit_id) || "codex";
    for (const slot of ["primary", "secondary"]) {
      const w = asRecord(limits?.[slot]);
      const [used, minutes, resets] = [w?.used_percent, w?.window_minutes, w?.resets_at];
      if (![used, minutes, resets].every((n) => typeof n === "number" && Number.isFinite(n)) || ts <= 0) continue;
      const window = windowName(minutes * 60);
      const key = JSON.stringify([limitId, window]);
      const prev = this.quota.get(key);
      if (prev && prev.observedAt > ts) continue;
      this.quota.set(key, {
        harness: "codex",
        provider: QUOTA_PROVIDER,
        limitId,
        window,
        usedPercent: Math.min(100, Math.max(0, used)),
        resetAt: resets * 1e3,
        durationMs: minutes * 6e4,
        observedAt: ts,
        planType: str(limits?.plan_type) || null
      });
    }
  }
  finish() {
    this.out.quota = [...this.quota.values()];
    this.out.unsupportedTurns = [...this.countedTurns].filter((t) => !this.recordedTurns.has(t)).length;
    if (!this.out.session) {
      this.out.badLines += this.pending.length;
      return this.out;
    }
    for (const p of this.pending) {
      const model = this.turnModels.get(p.turnId);
      if (!model) {
        this.out.badLines++;
        continue;
      }
      this.addCall(this.provider || FALLBACK_PROVIDER, model, p.ms, p.counts, null, entryHash("codex", p.responseId));
    }
    return this.out;
  }
};
async function readCodex(root, cache) {
  return scanJsonl({
    harness: "codex",
    root,
    dirs: [join5(root, "sessions"), join5(root, "archived_sessions")],
    cache,
    parser: (_path, size, mtimeMs) => new CodexParser(size, mtimeMs)
  });
}

// src/stats/harness/opencode.ts
import { open, stat as stat3 } from "node:fs/promises";
import { pathToFileURL } from "node:url";
var loadNodeSqlite = () => import("node:sqlite");
var QUERY = `
SELECT m.id AS id, m.session_id AS sid, s.parent_id IS NOT NULL AS child,
  COALESCE(json_extract(m.data, '$.time.created'), m.time_created) AS ms,
  json_extract(m.data, '$.providerID') AS provider, json_extract(m.data, '$.modelID') AS model,
  json_extract(m.data, '$.tokens.input') AS input, json_extract(m.data, '$.tokens.output') AS output,
  json_extract(m.data, '$.tokens.reasoning') AS reasoning,
  json_extract(m.data, '$.tokens.cache.read') AS cache_read, json_extract(m.data, '$.tokens.cache.write') AS cache_write,
  json_extract(m.data, '$.cost') AS cost
FROM message m LEFT JOIN session s ON s.id = m.session_id
WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') = 'assistant' ELSE 0 END`;
async function isFile(path) {
  try {
    return (await stat3(path)).isFile();
  } catch {
    return false;
  }
}
var BUSY_TIMEOUT_MS = 2e3;
var BUSY_CODES = /* @__PURE__ */ new Set([5, 6]);
var isBusy = (error) => {
  const code = error?.errcode;
  return typeof code === "number" && BUSY_CODES.has(code & 255);
};
async function isCheckpointedWal(path) {
  if (await isFile(`${path}-wal`)) return false;
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    return bytesRead === 20 && header[18] === 2 && header[19] === 2;
  } finally {
    await handle.close();
  }
}
async function readOpenCode(dbPath, load = loadNodeSqlite) {
  if (!await isFile(dbPath)) return emptyScan(false);
  let rows;
  try {
    const { DatabaseSync } = await load();
    const target = await isCheckpointedWal(dbPath) ? `${pathToFileURL(dbPath).href}?mode=ro&immutable=1` : dbPath;
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      rows = db.prepare(QUERY).all();
    } finally {
      db.close();
    }
  } catch (error) {
    if (isBusy(error)) return emptyScan(true, ["opencode: database busy, skipped"]);
    return emptyScan(true, ["opencode: database unreadable (missing node:sqlite or unexpected schema), skipped"]);
  }
  const calls = [];
  const spans = /* @__PURE__ */ new Map();
  let bad = 0;
  for (const r of rows) {
    const raw = counters([r.input, r.output, r.reasoning, r.cache_read, r.cache_write]);
    const cost = r.cost ?? null;
    const [id, sid, provider, model, ms] = [str(r.id), str(r.sid), str(r.provider), str(r.model), timeOf(r.ms)];
    if (!raw || cost !== null && (typeof cost !== "number" || !(cost >= 0)) || !id || !sid || !provider || !model || ms <= 0) {
      bad++;
      continue;
    }
    const [input, output, cacheRead, cacheWrite] = [nth(raw, 0), nth(raw, 1) + nth(raw, 2), nth(raw, 3), nth(raw, 4)];
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const session = sessionHash("opencode", sid);
    const entryId = entryHash("opencode", id);
    calls.push({
      harness: "opencode",
      session,
      entryId,
      ms,
      provider,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      cost
    });
    const span = spans.get(session);
    spans.set(session, {
      path: session,
      startMs: Math.min(ms, span?.startMs ?? ms),
      endMs: Math.max(ms, span?.endMs ?? ms),
      child: Number(r.child) === 1
    });
  }
  const sessionMetadata = [...mergeSessionMetadata([...spans.values()]).values()];
  return {
    ...emptyScan(true, unreadable("opencode", bad)),
    calls: calls.sort((a, b) => a.ms - b.ms),
    sessionMetadata,
    sessions: sessionMetadata.filter((s) => !s.child)
  };
}

// src/stats/harness/index.ts
var EXTERNAL_HARNESSES = ["claude", "codex", "opencode"];
var CACHE_VERSION2 = 2;
var harnessCachePath = (dir = agentDir()) => join6(dir, "pi-session-kit", "stats-harness-cache.json");
function harnessRoots(env = process.env, home = homedir2(), overrides = {}) {
  const data = env.XDG_DATA_HOME || join6(home, ".local", "share");
  return {
    claude: overrides.claude ?? (env.CLAUDE_CONFIG_DIR || join6(home, ".claude")),
    codex: overrides.codex ?? (env.CODEX_HOME || join6(home, ".codex")),
    opencode: overrides.opencode ?? (env.OPENCODE_DB || join6(data, "opencode", "opencode.db"))
  };
}
async function readHarnessCache(path) {
  let doc;
  try {
    doc = JSON.parse(await readFile2(path, "utf8"));
  } catch {
    return {};
  }
  const cache = {};
  const record2 = asRecordOf(doc);
  if (record2.version !== CACHE_VERSION2) return cache;
  for (const [harness, files] of Object.entries(asRecordOf(record2.harnesses)))
    cache[harness] = Object.fromEntries(
      Object.entries(asRecordOf(files)).filter((entry) => isParsedFile(entry[1]))
    );
  return cache;
}
async function writeHarnessCache(path, cache) {
  await mkdir2(dirname2(path), { recursive: true });
  const tmp = `${path}.${randomUUID2()}.tmp`;
  await writeFile2(tmp, JSON.stringify({ version: CACHE_VERSION2, harnesses: cache }));
  await rename2(tmp, path);
}
async function loadHarnesses(options) {
  const wanted = new Set(options.harnesses ?? EXTERNAL_HARNESSES);
  const roots = harnessRoots(options.env, options.home, options.roots);
  const cachePath2 = options.cache ?? harnessCachePath();
  const cache = await readHarnessCache(cachePath2);
  const before = JSON.stringify(cache);
  const scans = {
    claude: wanted.has("claude") ? await readClaude(roots.claude, cache) : emptyScan(false),
    codex: wanted.has("codex") ? await readCodex(roots.codex, cache) : emptyScan(false),
    opencode: wanted.has("opencode") ? await readOpenCode(roots.opencode, options.loadSqlite ?? loadNodeSqlite) : emptyScan(false)
  };
  if (JSON.stringify(cache) !== before) {
    try {
      await writeHarnessCache(cachePath2, cache);
    } catch {
      for (const h of wanted) if (h !== "opencode") scans[h].problems.push(`${h}: cache not written`);
    }
  }
  return scans;
}

// src/stats/snapshot.ts
var SNAPSHOT_VERSION = 2;
var VERSIONS = [1, 2];
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var HASH = /^[a-f0-9]{64}$/;
var MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
var MAX_BYTES = 128 * 1024 * 1024;
async function atomicJson(path, value) {
  await mkdir3(dirname3(path), { recursive: true });
  const tmp = `${path}.${randomUUID3()}.tmp`;
  try {
    await writeFile3(tmp, JSON.stringify(value), { mode: 384 });
    await rename3(tmp, path);
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
  const path = join7(dir, "pi-session-kit", "machine.json");
  try {
    return validateIdentity(await jsonFile(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir3(dirname3(path), { recursive: true });
  const identity = { machineId: randomUUID3(), label: "Pi machine" };
  const tmp = `${path}.${randomUUID3()}.tmp`;
  await writeFile3(tmp, JSON.stringify(identity), { flag: "wx", mode: 384 });
  try {
    await link(tmp, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(tmp);
  }
  return validateIdentity(await jsonFile(path));
}
function eventId(event, version = SNAPSHOT_VERSION) {
  const lead = version >= 2 ? [event.harness ?? "pi"] : [];
  const counters2 = [event.input, event.output, event.cacheRead, event.cacheWrite];
  if (event.entryId === null)
    return opaqueId(JSON.stringify([...lead, event.provider, event.model, event.ms, ...counters2]));
  return opaqueId(JSON.stringify([...lead, event.entryId, event.ms, event.provider, event.model, ...counters2]));
}
var sessionsOf = (loaded) => loaded.sessionMetadata ?? loaded.sessions;
function makeSnapshot(loaded, identity, exportedAt = Date.now(), quota = []) {
  const shards = /* @__PURE__ */ new Map();
  const shard = (month) => {
    let s = shards.get(month);
    if (!s) {
      s = { version: SNAPSHOT_VERSION, machineId: identity.machineId, month, events: [], sessions: [], quota: [] };
      shards.set(month, s);
    }
    return s;
  };
  const sessionId = (value) => HASH.test(value) ? value : opaqueId(`session:${value}`);
  for (const c of loaded.calls) {
    const e = {
      harness: c.harness,
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
  for (const q of mergeQuota(quota))
    shard(monthOf(q.observedAt)).quota?.push({
      harness: q.harness,
      provider: q.provider,
      limitId: q.limitId,
      window: q.window,
      usedPercent: q.usedPercent,
      resetAt: q.resetAt,
      durationMs: q.durationMs,
      observedAt: q.observedAt,
      planType: q.planType
    });
  for (const s of sessionsOf(loaded))
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
  if (!VERSIONS.includes(value.version) || typeof value.machineId !== "string" || !UUID.test(value.machineId) || !name(value.label) || !positive(value.exportedAt) || !Array.isArray(value.shards))
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
var SHARD_KEYS = ["version", "machineId", "month", "events", "sessions"];
var quotaKey = (q) => JSON.stringify([q.provider, q.limitId, q.window]);
function validateQuota(q, month) {
  exact(q, [
    "harness",
    "provider",
    "limitId",
    "window",
    "usedPercent",
    "resetAt",
    "durationMs",
    "observedAt",
    "planType"
  ]);
  if (!HARNESSES.includes(q.harness) || ![q.provider, q.limitId, q.window].every(name) || typeof q.usedPercent !== "number" || !Number.isFinite(q.usedPercent) || q.usedPercent < 0 || !positive(q.resetAt) || !positive(q.durationMs) || !positive(q.observedAt) || monthOf(q.observedAt) !== month || !(q.planType === null || name(q.planType)))
    throw new Error("Invalid snapshot quota");
}
function validateShard(value, manifest, month) {
  const v2 = manifest.version >= 2;
  exact(value, v2 ? [...SHARD_KEYS, "quota"] : SHARD_KEYS);
  if (value.version !== manifest.version || value.machineId !== manifest.machineId || value.month !== month || !Array.isArray(value.events) || !Array.isArray(value.sessions))
    throw new Error("Invalid shard header");
  const seenEvents = /* @__PURE__ */ new Set();
  for (const e of value.events) {
    exact(e, [
      "id",
      ...v2 ? ["harness"] : [],
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
    if (!hash(e.id) || v2 && !HARNESSES.includes(e.harness) || seenEvents.has(e.id) || !(e.entryId === null || hash(e.entryId)) || !hash(e.sessionId) || !positive(e.ms) || monthOf(e.ms) !== month || !name(e.provider) || !name(e.model) || ["router", "faux", "faux-provider", "fake-provider"].includes(e.provider) || ![e.input, e.output, e.cacheRead, e.cacheWrite].every(count) || e.input + e.output + e.cacheRead + e.cacheWrite === 0 || !(e.cost === null ? v2 : typeof e.cost === "number" && Number.isFinite(e.cost) && e.cost >= 0) || eventId(e, manifest.version) !== e.id)
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
  if (v2) for (const q of value.quota) validateQuota(q, month);
  return value;
}
function validateSnapshot(snapshot) {
  const metadata = /* @__PURE__ */ new Set();
  const events = /* @__PURE__ */ new Set();
  const quota = /* @__PURE__ */ new Set();
  for (const s of snapshot.shards) {
    for (const session of s.sessions) {
      if (metadata.has(session.id)) throw new Error("Duplicate session metadata");
      metadata.add(session.id);
    }
    for (const e of s.events) {
      if (events.has(e.id)) throw new Error("Duplicate event identity");
      events.add(e.id);
    }
    for (const q of s.quota ?? []) {
      if (quota.has(quotaKey(q))) throw new Error("Duplicate quota window");
      quota.add(quotaKey(q));
    }
  }
  for (const s of snapshot.shards)
    for (const e of s.events) if (!metadata.has(e.sessionId)) throw new Error("Missing session metadata");
}
var fatalProblem = (p) => p.endsWith(": cache not written") || p.includes(" unreadable files");
async function exportStats(dir, output, root = sessionsDir(dir), options = {}) {
  const wanted = new Set(options.harnesses ?? ["pi"]);
  const identity = await machineIdentity(dir);
  const loaded = wanted.has("pi") ? await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true }) : { calls: [], sessions: [], errors: 0, badLines: 0 };
  if (loaded.errors || loaded.badLines)
    throw new Error(`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`);
  const external = EXTERNAL_HARNESSES.filter((h) => wanted.has(h));
  const scans = await loadHarnesses({
    harnesses: external,
    roots: options.roots,
    env: options.env,
    home: options.home,
    cache: harnessCachePath(dir),
    loadSqlite: options.loadSqlite
  });
  const report = {};
  const calls = [...loaded.calls];
  const sessionMetadata = [...sessionsOf(loaded)];
  const quota = [];
  for (const h of external) {
    const scan = scans[h];
    if (scan.problems.some(fatalProblem))
      throw new Error(`Incomplete ${h} scan: ${scan.problems.filter(fatalProblem).join("; ")}`);
    report[h] = { found: scan.found, problems: scan.problems };
    calls.push(...scan.calls);
    sessionMetadata.push(...scan.sessionMetadata);
    quota.push(...scan.quota);
  }
  const snapshot = makeSnapshot({ ...loaded, calls, sessionMetadata }, identity, Date.now(), quota);
  validateSnapshot(snapshot);
  const snapshotDir = join7(output, "machines", identity.machineId);
  await mkdir3(snapshotDir, { recursive: true });
  for (const s of snapshot.shards) {
    const text = JSON.stringify(s);
    const sha256 = opaqueId(text);
    const file = `${s.month}-${sha256}.json`;
    validateShard(s, snapshot.manifest, s.month);
    await atomicJson(join7(snapshotDir, file), s);
    snapshot.manifest.shards.push({ month: s.month, file, sha256, bytes: Buffer.byteLength(text) });
  }
  await atomicJson(join7(snapshotDir, "manifest.json"), validateManifest(snapshot.manifest));
  return { machineId: identity.machineId, snapshotDir, ...external.length ? { harnesses: report } : {} };
}
var globalPath = (dir) => join7(dir, "pi-session-kit", "stats-global.json");
async function jsonFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Not a bounded regular snapshot file");
  return JSON.parse(await readFile3(path, "utf8"));
}
async function readGlobal(dir) {
  const empty = { version: SNAPSHOT_VERSION, importedAt: 0, machines: {}, problems: [] };
  try {
    const v = await jsonFile(globalPath(dir));
    exact(v, ["version", "importedAt", "machines", "problems"]);
    if (!VERSIONS.includes(v.version) || !count(v.importedAt) || !record(v.machines) || !Array.isArray(v.problems) || !v.problems.every((p) => typeof p === "string"))
      throw new Error("Invalid global cache");
    for (const [id, machine] of Object.entries(v.machines)) {
      exact(machine, ["manifest", "shards"]);
      const m = validateManifest(machine.manifest);
      if (m.machineId !== id || !Array.isArray(machine.shards) || machine.shards.length !== m.shards.length)
        throw new Error("Invalid cached machine");
      for (const [i, s] of machine.shards.entries()) {
        const ref = nth(m.shards, i);
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
    for (const entry of await readdir2(join7(input, "machines"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) {
        problems.push("Invalid machine directory");
        continue;
      }
      const id = entry.name;
      present.add(id);
      try {
        const base = join7(input, "machines", id);
        const manifest = validateManifest(await jsonFile(join7(base, "manifest.json")));
        if (manifest.machineId !== id) throw new Error("Machine identity mismatch");
        const shards = [];
        for (const ref of manifest.shards) {
          const path = join7(base, ref.file);
          const info = await lstat(path);
          if (!info.isFile() || info.size !== ref.bytes || info.size > MAX_BYTES)
            throw new Error("Invalid shard size/type");
          const text = await readFile3(path, "utf8");
          if (opaqueId(text) !== ref.sha256) throw new Error("Shard digest mismatch");
          const s = validateShard(JSON.parse(text), manifest, ref.month);
          if (JSON.stringify(s) !== text) throw new Error("Noncanonical shard JSON");
          shards.push(s);
        }
        validateSnapshot({ manifest, shards });
        const prior = machines[id];
        if (prior && manifest.exportedAt < prior.manifest.exportedAt) throw new Error("Older machine snapshot");
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
var USAGE = "usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] [--harness pi,claude,codex,opencode] [--claude-dir DIR] [--codex-dir DIR] [--opencode-db FILE] | import --agent-dir DIR --input REPO";
var FLAGS = [
  "--agent-dir",
  "--output",
  "--input",
  "--sessions-dir",
  "--harness",
  "--claude-dir",
  "--codex-dir",
  "--opencode-db"
];
var EXPORT_ONLY = ["--sessions-dir", "--harness", "--claude-dir", "--codex-dir", "--opencode-db"];
function harnessList(value) {
  const names = value.split(",");
  if (new Set(names).size !== names.length || !names.every((n) => HARNESSES.includes(n)))
    throw new Error(USAGE);
  return names;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = /* @__PURE__ */ new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !value || value.startsWith("--") || options.has(flag) || !FLAGS.includes(flag)) throw new Error(USAGE);
    options.set(flag, value);
  }
  const dir = resolve3(options.get("--agent-dir") ?? agentDir());
  const output = options.get("--output");
  const input = options.get("--input");
  if (command === "export" && output !== void 0 && input === void 0) {
    const path = (flag) => {
      const value = options.get(flag);
      return value ? resolve3(value) : void 0;
    };
    const harnesses = options.get("--harness");
    const result = await exportStats(dir, resolve3(output), path("--sessions-dir"), {
      harnesses: harnesses === void 0 ? void 0 : harnessList(harnesses),
      roots: { claude: path("--claude-dir"), codex: path("--codex-dir"), opencode: path("--opencode-db") }
    });
    console.log(JSON.stringify(result));
  } else if (command === "import" && input !== void 0 && output === void 0 && !EXPORT_ONLY.some((f) => options.has(f))) {
    const result = await importStats(dir, resolve3(input));
    console.log(JSON.stringify(result));
    if (result.problems.length) {
      console.error(result.problems.join("\n"));
      process.exitCode = 1;
    }
  } else throw new Error(USAGE);
}
async function run() {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Stats operation failed");
    process.exitCode = 1;
  }
}
function isEntrypoint() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL2(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isEntrypoint()) void run();
export {
  main,
  run
};
