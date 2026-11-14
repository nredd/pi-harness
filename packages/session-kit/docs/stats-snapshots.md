# Offline stats and portable snapshots

Build the committed `dist/pi-stats-export.mjs` with `npm ci && npm run build:stats-export`.
The exact esbuild version and dependencies are locked; tests assert byte-identical rebuilds.
Copy only that file. Runtime is Node 22+ with builtins only, no Pi install, extension, private
repository, package install, auth or network access. Importing the artifact is silent, even when
an importing process supplies a nonexistent entrypoint argument; direct and symlinked Node execution
still run the CLI. Packed-CLI tests explicitly launch `node`, including when their Vitest
host is Bun; this tests the artifact's declared runtime, not Bun's entry-module resolver.

Chart tick steps parse decimal powers directly rather than using implementation-approximated
exponentiation, keeping large finite ticks consistent between Node and Bun. Steps above the
numeric range retain infinite headroom.

```
node ARTIFACT export --agent-dir DIR --output OUT [--sessions-dir ROOT]
node ARTIFACT import --agent-dir DIR --input REPO
```

`--agent-dir` defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. The session root defaults to
`PI_CODING_AGENT_SESSION_DIR`, then `DIR/sessions`; `--sessions-dir` takes precedence. History
already cached under former roots is retained, even after files disappear. Paths are resolved
locally and never exported. Run export before fetch/commit/push, then import the updated data
checkout. Git, locking concurrent sync runs, retrying pushes and network deadlines belong to the
sync helper, not this data-only artifact.

CLI results:

- Export: `{ "machineId": "<UUID>", "snapshotDir": "<OUT>/machines/<UUID>" }` on stdout.
- Import: `{ "imported": N, "retained": N, "problems": [], "importedAt": MS }` on stdout.
- Exactly one JSON object is emitted. Diagnostics go to stderr. Invalid commands, malformed local
  scans, unwritable caches and publication failures exit nonzero. Partial/corrupt imports emit
  a JSON result and exit nonzero, retaining every failed machine's last-good snapshot.
- A failed export never replaces the previous manifest. Its validated immutable shards may remain
  unpublished. Export writes only its own machine directory; it never edits another machine.

Installation state, never synced:

- `DIR/pi-session-kit/machine.json`: persistent UUID v4 and label, created exclusively and
  atomically on first use. Default label is `Pi machine`, not the hostname. A corrupt identity
  fails rather than silently enrolling another machine. Copying an entire agent dir also copies
  its installation identity: remove `machine.json` on a genuinely new installation before export.
- `DIR/pi-session-kit/stats-cache.json`: local parser cache v2, including file paths and compact
  usage tuples. Version 1 entries for deleted files stay intact; existing files reparse even if
  their mtime/size match. Strong identities are not invented for inaccessible legacy files.
  Failed stat/parse operations count as incomplete history; a failed reparse retains the last-good
  cached record. Invalid cached identities and raw provider/model pairs are discarded. Persisted
  child markers apply only to the matching session ID, surviving user-visible renames.
- `DIR/pi-session-kit/stats-global.json`: one atomically replaced document containing validated
  last-good machine snapshots, last successful import time and coverage problems. Imports do not
  mutate local usage or installation identity. A wholly failed import does not advance the sync
  time; a partial import records valid updates and marks coverage incomplete. The assembled cache
  accepts up to 128 MiB; exceeding that limit fails before replacement and retains its last-good
  bytes. Tests inject final-document byte accounting at the exact limit and one byte over, while
  retaining real import validation and atomic publication.

Snapshot version 1:

```
machines/<UUID>/manifest.json
machines/<UUID>/<YYYY-MM>-<sha256>.json
```

Manifest exact keys:

- `version`: `1`.
- `machineId`: persistent UUID v4, matching its directory.
- `label`: installation label, maximum 1024 characters. Not a session name.
- `exportedAt`: positive UTC Unix milliseconds.
- `shards`: unique month references, each exactly `{month, file, sha256, bytes}`. `file` MUST
  equal `<month>-<sha256>.json`. No absolute paths, traversal or arbitrary filenames.

Shard exact keys: `{version, machineId, month, events, sessions}`. All shard JSON is canonical
`JSON.stringify` output (no indentation/newline), bounded to 128 MiB per file. Manifest hashes
cover exact UTF-8 shard bytes. Immutable content-addressed shards are published first, manifest
last; unreferenced old shard generations are deliberately retained and ignored. No cleanup races
with readers. Each manifest references exactly one shard per month.

Event exact keys:

- `id`: SHA-256 event fingerprint.
- `entryId`: SHA-256 of `entry:<preserved assistant entry ID>`, or `null` for legacy records.
- `sessionId`: opaque session ID.
- `ms`: original positive UTC Unix milliseconds, in the shard's UTC month.
- `provider`, `model`: raw physical attribution, each nonempty and at most 1024 characters.
- `input`, `output`, `cacheRead`, `cacheWrite`: nonnegative safe integers, not all zero.
- `cost`: finite nonnegative recorded notional cost.

The identified fingerprint is SHA-256 of the JSON array
`[entryId, ms, provider, model, input, output, cacheRead, cacheWrite]`.
Notional price changes do not create new events. Different entry IDs survive equal usage. Copied entries across forks/machines count once. Legacy
fingerprinting and matching use `[provider, model, ms, input, output, cacheRead, cacheWrite]`,
intentionally without cost to preserve the old tuple rule; identified counterparts supersede
legacy duplicates.

Session exact keys: `{id, startMs, endMs, child}`. Header IDs hash as `session:<header ID>`;
unidentified legacy sessions use a local path hash and therefore cannot always be matched across
machines. Session metadata is independent of event dedup, lives in the start timestamp's UTC
month, and merges time bounds by ID through the same helper for local and imported histories.
Children retain usage but do not contribute to session count.
Only sessions owning a retained event count. The oldest session owns copied events, independent
of machine read order. Every exported event references session metadata.

No message content, tool arguments/results, paths, session names, environment, credentials or
source objects are exported. Explicit projections, not object spreads, enforce the allowlist.
Raw attribution is retained to avoid display-sanitization collisions. Schema validators reject
unknown fields, unsupported versions, duplicate IDs, invalid counters/time/months, excluded test
providers, identity/digest/byte-size mismatches, symlink files and missing session metadata.

Import validates a whole machine before replacement, retaining last-good data for bad, missing
or older snapshots. Other valid machines still advance. Only the final validated global document
is atomically renamed, so `/stats` sees either the old or new complete cache, never a mixed import.
Producer updates are invisible until the producer exports AND the viewer imports. Coverage counts
known machines, not undiscovered installations; it is not proof that every machine has synced.

`/stats` freshly scans local sessions and combines them with this cache without network access.
Its header labels cached coverage, **viewer last import**, local-only/never-imported state and
incomplete coverage. Tab/Shift-Tab cycles Overview, Models and **Machines**. Machines lists each
known installation's label plus full opaque UUID (default labels may repeat), fresh local scan
status, and each remote producer's **exported-at** UTC instant and age at opening. Use j/k or
arrows to scroll; narrow panes wrap details. Print/JSON output includes the same provenance;
empty histories include it in the notification. Range/model filters do not filter provenance.

The viewer import clock is NOT producer freshness: importing a ten-day-old export today still
shows a ten-day producer age. Future export clocks say `future; clock skew`, never fresh.
Absent/invalid display timestamps say `unknown`. Invalid v1 manifests still fail validation and
retain last-good data; rejected known UUIDs without last-good data show unknown export time.
Missing/rejected sources with retained data say `Incomplete import; retained last-good snapshot`.
Existing v1 snapshots require no migration or re-export. Unreadable caches report incomplete
coverage, not invented machine identities. Only known sources are listed; this cannot discover
machines that have never supplied a snapshot. No freshness threshold implies fleet completeness.

Labels come only from the existing local `machine.json`, never automatic hostname/environment
collection. Keep custom labels non-sensitive: they are exported. No schema or sync cadence changes.
Future calls are ignored in display totals, not removed from durable history. Statistics
are not subscription quota measurements or router inputs.

Harness readers (#367, reader layer only; not yet exported or shown):

`src/stats/harness/` reads Claude Code, Codex CLI and OpenCode usage into the same `Call` model as
pi (`Call.harness`: `pi | claude | codex | opencode`). Roots: `CLAUDE_CONFIG_DIR` or `~/.claude`;
`CODEX_HOME` or `~/.codex`; `OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`. Local file
reads only. A missing root is silent ("not installed"). Parsed files are cached in
`DIR/pi-session-kit/stats-harness-cache.json` by size and mtime, history for deleted files kept.
That local, never-synced file is keyed by absolute transcript path (so Claude's cwd-encoded project
directory names live there as keys); its values and every reader result carry no paths.

- Claude: `projects/**/*.jsonl` including `subagents/`. One response is written once per content
  block, so rows collapse by `(message.id, requestId)`, keeping the largest output count.
  Subagent files and sidechain rows count toward tokens, not Sessions. No cost, no quota on disk.
- Codex: `sessions/` and `archived_sessions/` rollouts. `token_usage_record` rows are joined to
  `turn_context.model` by turn. `input` is `input_tokens` minus the cached and cache-write subsets.
  Turns without per-turn records (older Codex, including old turns of a resumed rollout) are
  skipped with a count-only diagnostic, never approximated.
  `rate_limits` from `token_count` rows become quota observations (provider `openai-codex`),
  freshest per `(limitId, window)`. No account dimension.
- OpenCode: one read-only `node:sqlite` query (`immutable=1` only when the WAL is checkpointed and
  absent, so a read never creates `-shm`/`-wal` and pending WAL rows are always visible; 2s busy
  timeout, then a generic "database busy" diagnostic) that
  projects only counters, IDs, timestamps and model names. `reasoning` tokens count as output. The
  schema follows third-party readers; a mismatch or missing `node:sqlite` is a diagnostic.
- Entry IDs hash `<harness>:<native id>`, session IDs `<harness>-session:<native id>`. Only counts,
  timestamps, raw provider/model names, Codex quota labels (`limit_id`, `plan_type`, percentages,
  reset times) and hashes are projected: no text, tool arguments, cwd,
  titles, directory names, account IDs or credentials. `history.jsonl`, `auth.json`, credential
  files and Codex SQLite databases are never opened. Diagnostics are counts only.
- Cost is recorded as 0 for Claude and Codex until snapshot v2 can carry `null`.

Harness API:

- `src/stats/library.ts` is a Pi-independent barrel for parser, aggregation and snapshot APIs.
- `parseSession`, `flatten`, `dedupCalls`, `hourlySeries`, `makeSnapshot`, `validateManifest`,
  `validateShard`, `validateSnapshot`, `exportStats`, `importStats`, `loadCombined`, `coverageLabel`.
- `hourlySeries(calls, "5h" | "24h", now, keyOf?)` is deterministic, zero-filled, filters exact
  rolling boundaries and labels partial edges. UTC buckets keep repeated DST hours separate;
  viewer-local labels carry UTC offsets, including fractional-offset zones.

Limits: legacy no-ID copies can only use tuple dedup, legacy session metadata without header IDs
cannot reliably match across machines, and concurrent sync workflows must serialize writes to
one agent directory. The combined global cache is bounded to 128 MiB; a larger import fails
without replacing last-good data. There is no automatic discovery/network refresh or daemon. Reinitializing
both the local parser cache and source history permanently loses that machine's local history;
keep these installation files out of synced snapshots but do not routinely delete them.
