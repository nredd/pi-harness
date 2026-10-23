# pi-dev-tools

Published to npm as `@nredd/pi-dev-tools` (public). From `0.5.1`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-dev-tools@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.5.1` adds `createDevTools(options)` (injectable `ssh`, `py`, `cargo` tool options; the default export is unchanged) and fixes process output that dropped a short line sharing a chunk with an oversized one.
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). References below to standalone repositories,
chezmoi pins, and installed-runtime harness gates describe the legacy deployment, not verification
of this package.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, there are no runtime dependencies and no sibling plugin is required. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (see the repository's `docs/package-contracts.md`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

Typed pi tools for the workflows agents otherwise drive through raw Bash: git, ssh, Python
(uv, ruff, ty, pytest) and Rust (cargo). Each tool spawns the real binary with an argv array,
maps exit codes to named states, bounds output, and returns `structuredContent` alongside the
compact text the model reads.

Tool groups land one per PR. Current state is in the table below.

| Group | Tools | Status |
| --- | --- | --- |
| core | `run`, `bound`, `withLock`, `withFileLock`, `toolResult` (shared, not model-visible) | done |
| git | `git_status`, `git_diff`, `git_log`, `git_show`, `git_commit`, `git_worktree_list`, `git_worktree_add`, `git_worktree_remove`, `git_worktree_prune`, Bash guard | done |
| ssh | `ssh_exec`, `ssh_pull`, `ssh_push` | done |
| py | `py_lint`, `py_format`, `py_typecheck`, `py_test`, `py_uv` | done |
| cargo | `cargo_check`, `cargo_clippy`, `cargo_fmt`, `cargo_test`, `cargo_build`, `cargo_run`, `cargo_doc`, `cargo_bench`, `cargo_add` | done |
| resource | `resource_snapshot` | done |

## Conventions every tool follows

- No shell. `spawn(cmd, argv)`, stdin closed or fed a fixed script, child in its own process
  group, SIGTERM then SIGKILL 2s later on timeout or abort, hard resolve 1s after that so a
  grandchild holding the pipes cannot hang the caller. macOS and Linux only
- When a command settles, including a normal leader exit, whatever is left of its process group
  is SIGKILLed, so a background descendant cannot outlive the tool call. Only the owned group is
  signalled (never a bare pid). SSH is the exception: the local `ssh` is the group, so remote
  processes it started can keep running after the local client exits
- Output is capped at pi's `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`, truncation notice
  included. When cut, the full text is written to `$TMPDIR/pi-dev-tools-*/<label>-N.txt` and
  the path is named in the result
- `run` caps captured stdout/stderr independently. Its stderr line listener drops only individual
  oversized lines, through their newline or EOF; valid following lines are delivered even when
  coalesced into the same chunk or after the capture cap is reached. Listener errors are swallowed
- Exit codes become named states (`violations`, `no-tests`, `tool-error`, ...), never a bare
  "exit 1"
- `annotations.readOnlyHint` is set honestly. The `pi-plan-mode` fork admits annotated read-only
  tools in Plan mode; everything else is denied there
- `outputSchema` + `structuredContent` on every tool, `isError: true` on red with the data intact
- Default transcript renderer, so every call settles as one `call · summary` row

## Resource awareness

`resource_snapshot({process_limit?, interval_ms?})` is an always-read-only observer for a parent or subagent to call before it knowingly starts a large test or compile. A `before_agent_start` system-prompt hook carries this guidance in parent and child sessions even while the tool is deferred: discover it with the available tool-search facility first, then use the result to choose targeted scope, workers, or timing. It never forces activation, schedules work, locks commands, or changes concurrency.

- Collection is the published [`@nredd/pi-resource-sampler`](../resource-sampler/README.md), pinned to exactly `0.1.0` as a runtime dependency (installed from the registry, never the workspace copy; a test asserts the resolved module). npm would link the same-versioned `packages/resource-sampler` workspace, so the root lockfile carries an explicit nested `packages/dev-tools/node_modules/@nredd/pi-resource-sampler` registry entry with the published integrity. `npm ci`/`npm install` keep it; `npm dedupe` or regenerating the lockfile drops it, and that test then fails. Each call creates a private sampler, samples twice `interval_ms` apart (default 500, 100..5000), then disposes it, which awaits any helper reaping. No background polling or state survives the call.
- Reports logical CPU count, 1/5/15-minute load (`null` on Windows), aggregate host interval CPU `cpu.utilization` (0..100) and `interval.{requestedMs,measuredMs}`, total/free memory, Linux `MemAvailable`, and optional macOS `memory_pressure -Q` free percentage or Linux PSI `some avg10` from the sampler. Missing optional metrics remain `null`, never invented.
- Returns at most 50 process entries, 12 by default: PID, parent PID, interval CPU, RSS bytes and executable basename. Interval CPU is a typed metric (`available` with a value where 100 means one logical core, otherwise `warming` or `unavailable` with a reason), never a zero stand-in. Linux measures it; Darwin cannot (one-second `ps` start precision cannot exclude PID reuse), so it is `unavailable` there. `ranking` is `interval-cpu` (measured entries first, then RSS) or `rss`. No `ps` lifetime or decaying average is reported or relabelled.
- `coverage` passes through the sampler's bounded scan (`complete`, `enumerated`, `sampled`, `skipped`, `bytesRead`, finite `reasons`); `truncated` is `!coverage.complete`. The scan is not atomic and short-lived work may be missed.
- No process arguments, environments, users or paths are collected; names are control-stripped basenames. Cancellation and sampler failures reject the call rather than returning a partial snapshot; the optional Darwin pressure probe gets the same signal, and failed, aborted, timed-out or truncated pressure probes stay `null`.
- Parent PIDs let a caller see real OS process trees, but OS process metadata has no proven link to a Pi parent, session, or agent. Use actual subagent/task information separately; do not claim process-to-agent attribution from this tool.
- macOS and Linux process metadata are supported. Other platforms return an explicit unavailable reason while retaining the portable memory fields.

API change from 0.5.x (`structuredContent`): entries drop `cpuPercent` (ps average) and `elapsed`, which the sampler does not measure, and gain `parentPid` plus the `cpu` metric. Additive: `interval`, `cpu.utilization`, `processes.ranking`, `processes.coverage`, and the `interval_ms` parameter. `cpuSemantics`, `truncated`, `limit` and the memory fields keep their names. The `resourceSnapshot(limit, options, signal, intervalMs?)` seams are now `createSampler`, `readFile` and `run`; the per-OS-primitive seams are gone.

## git

Reads (`git_status`, `git_diff`, `git_log`, `git_show`) are annotated read-only and run with
`--no-pager --no-color --literal-pathspecs`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`,
`LC_ALL=C`, `timeout_s` default 60. Refs (`base`, `ref`, `rev`) may not start with `-` and go
after `--end-of-options`. `git_status` parses porcelain v2 (`-z`, renames and copies carry the
old path, a gone upstream reads `gone`). `git_diff` leads with the stat and caps the patch;
`git_log` is `sha date author: subject`, max 200; `git_show` peels tags to the commit. Failures
name a state (`not a git repository`, `unknown revision`, `path not tracked`, `no upstream`,
`push rejected`) and return `{ error }` as structured content.

`git_commit {subject, why?, changes?, paths, push?=true}`:

- `paths` is required; the repo root in any spelling, `..` segments, pathspec magic (`:/`) and
  flags are rejected. The commit is `git commit -- <paths>`, so it contains exactly those files;
  anything else already staged stays in the index. A rename needs both the old and the new path.
  Nothing to commit is its own state
- The subject must be a capitalized imperative, <= 72 chars, no trailing period, no
  conventional-commit prefix, no em or en dash. An `area:` prefix is fine
- Message is `subject`, optional `why`, `Changes:` bullets, then
  `Co-Authored-By: Claude <noreply@anthropic.com>`, passed on stdin with `-F -`
- Never `--no-verify`, `--amend` or `--no-gpg-sign`. Hook output is relayed on failure, and
  `files were modified by this hook` is flagged as "re-stage and call again". Nothing retries
- Push is `git push <upstream remote> HEAD`, or `-u origin HEAD` for a branch without an upstream.
  A push failure returns `stage: "push"` with the sha so the caller fixes the push instead of
  committing twice. `signed` is true for `%G?` in `G`, `U`, `X`, `Y`

Bash guard (`tool_call` on `bash`, always on): blocks `--no-verify` (and `-n` on `commit`, where
it means `--no-verify`; `push -n` is a dry run and passes), plain `--force` / `-f` / `+ref`
pushes including clustered `-fu` (not `--force-with-lease`), and `--no-gpg-sign` or
`-c commit.gpgsign=false`. Quoted strings are ignored and `git` must be the command word of its
segment or substitution, so `echo 'git push --force'` passes and `$(git commit -n)` does not.
Known limits, by design (Plan mode is the policy, this is a seatbelt): `/usr/bin/git`, `sudo git`,
`command git`, `xargs git`, and `bash -c '...'` bodies are not inspected.

## git worktrees

`git_worktree_list` is annotated read-only (Plan mode admits it); `add`, `remove` and `prune` are
not. All run the real `git` with the same env and flags as the other git tools, take `cwd` and
`timeout_s` (default 60), and return `{ error }` on failure with a named state in the text.
Mutations (`add`, `remove`, `prune`) take two locks keyed on the git COMMON dir: `withLock`
in-process, then `withFileLock` across processes, so concurrent pi panes cannot race on
`.git/worktrees` either. The file lock is an atomic `mkdir` of `<common dir>/pi-dev-tools-worktree.lock`
holding `owner.json` `{pid, startedAt, token}`, always released in `finally` (token-checked, never
throws). Only a lock whose owner pid is dead is reclaimed (plus an ownerless directory older than 2s);
there is NO age-based reclaim, a live pid is never broken. Reclaimers serialize behind a short-lived
`pi-dev-tools-worktree.lock.reclaim` guard directory and re-verify the same token and a dead pid inside
it. The guard records its owner with an immutable `<pid>.<token>` filename. Only a confirmed dead
guard owner is reclaimed, never a live owner based on age. Release/reclaim unlink only the token-owned
filename, then remove the empty guard directory, never a replacement owner's contents. Empty or
malformed guards (including a crash before owner publication) require manual inspection; bounded
`lock-timeout` errors name the guard path. Residual risk: PID reuse. A recycled pid makes a stale lock
look live; waiters then fail with
`lock-timeout` naming the pid, and a human can remove the lock directory. If `owner.json` cannot be
written the directory is removed and the call fails with `lock-failed`. Waiting is bounded at 15s,
then the call fails with `lock-timeout` naming the holder pid. `list` takes no lock. `list` and
`prune` text is capped like every other tool (truncation notice, full text spilled to a temp
file); structured content stays complete.

- `git_worktree_list`: parses `git worktree list --porcelain -z` into `path`, `head`, `branch`
  (short name), `detached`, `bare`, `main` (first entry), `locked`/`lockReason`,
  `prunable`/`prunableReason`. Text is one line per worktree
- `git_worktree_add {branch, base?, path?}`: default path is `<main worktree>-<slug>` next to the
  main worktree, where slug is the branch lowercased with anything outside `[a-z0-9._-]` -> `-`.
  A missing branch is created with `-b` from `base` (default HEAD); an existing branch is checked
  out, `base` is refused for it, and a branch checked out in another worktree is refused with
  that path (`branch checked out elsewhere`). Also refused: invalid branch name, unknown `base`,
  existing non-empty `path`. `branch` and `base` may not start with `-` and go after
  `--end-of-options`
- `git_worktree_remove {path, force?}`: refuses the main worktree, the session cwd (or `cwd`)
  and any parent of it (`cwd is inside`), a locked worktree even with `force`, and a dirty one
  (modified or untracked) unless `force`. A worktree whose directory is gone points at prune.
  The branch is always kept
- `git_worktree_prune {dry_run?}`: `git worktree prune --verbose`; reports `{name, reason}` per
  record, `dry_run` changes nothing

Preflight checks (branch exists, base resolves, path state) separate "no" from "could not tell":
a timeout, abort, spawn failure or unexpected exit is reported as such, never as a missing
branch or bad revision. An unreadable target path is `path unreadable (EACCES)`; a path removed
mid-check counts as free. If the final HEAD lookup fails after the worktree was created, the
error says `head-unreadable` and that the worktree exists.

States: `branch checked out elsewhere`, `branch exists`, `path exists`, `path unreadable`,
`dirty worktree`, `locked worktree`, `main worktree`, `lock-timeout`, `lock-failed`, `head-unreadable`, plus the shared `not a git repository`, `unknown revision`.
The Bash guard does not steer raw `git worktree ...`; it only blocks hook-skipping and force
pushes, as for every other git command.

## ssh

`ssh_exec {host, command, cwd?, timeout?=30}` runs the user's own `ssh` with
`-T -a -x -o BatchMode=yes -o ConnectTimeout=8 -o ClearAllForwardings=yes -o RequestTTY=no --
<host> 'exec sh -s'`, so the per-host `ForwardAgent`/`ForwardX11` in `~/.ssh/config` is
overridden and nothing can prompt.

- `host` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and be a concrete `Host` alias in
  `~/.ssh/config` (`Include`s followed, wildcards and `!` entries skipped). Option injection is
  impossible by construction and the `--` keeps it that way
- The command travels on stdin: written to a remote `mktemp` file through a quoted heredoc with
  a per-call random delimiter, run as `sh "$tmp" </dev/null` inside `( ... )` (so a `cat` or
  `read` in the command cannot eat the wrapper), then a `printf '\n__PI_RC=%d'` sentinel. A
  trap removes the temp file even when the local ssh dies first. Inside the command `$0` is the
  temp path and there are no positional arguments. No remote argv quoting, no command in `ps`, multi-line
  scripts and heredocs work, an `exit N` ends the command rather than the shell, and unbalanced
  quotes or parentheses stay inside the file (sh exits 2 with a syntax error)
- States: `ok`, `command-failed` (remote exit, including 255; NOT a tool error, `grep` exiting 1
  is normal), `cwd-missing` (`cd` failed: marker plus exit 97, so neither a command exiting 97
  nor one printing the marker can fake it),
  `ssh-failed` (no sentinel: connection failure or a remote without `mktemp`), `timeout`,
  `aborted`. A timeout or abort kills the local ssh only; the remote command may keep running
- Output and the spill file are redacted for `Bearer ...`, `token|secret|password|api_key` style
  assignments in any case or quoting, and JWT signatures. Count-like keys (`TOKEN_COUNT=`) are
  over-redacted on purpose
- No ControlMaster: measured steady-state gain was ~70ms per call, not worth stale sockets
- No `stdin` parameter (the plan had one): the script already owns stdin, a heredoc in `command`
  covers the need, and Plan mode's gate refuses the key anyway
- Plan mode: the `pi-plan-mode` fork admits `ssh_exec` as annotated read-only and re-validates
  `{host, command}` against `safeSubcommands.ssh` and the remote reviewed policy, so `rm`,
  `cd`, redirects and pipes to interpreters are blocked there. Outside Plan mode the tool runs
  whatever it is given, like `bash`

`ssh_pull {host, remote_path, local_path, overwrite?}` and `ssh_push {host, local_path,
remote_path, overwrite?}` use `scp -O -q` with the same options and refuse to overwrite unless
asked (`ssh_push` probes the remote path with `test -e` first; a small race remains between probe
and copy). Legacy scp hands `remote_path` to the remote shell, so it is restricted to
`[A-Za-z0-9._/+@%:=,-]`: no spaces, quotes, `~` or metacharacters. `ssh_pull` is read-only,
`ssh_push` is not. Failures are named: `missing`, `permission denied`, `connection failed`.

`~/.ssh/config` parsing follows OpenSSH: relative `Include` paths resolve against `~/.ssh`, not
the including file; `Host=x`, quoted names, trailing comments and CRLF are handled.

## py

All five run `uv run --frozen <tool>` from the nearest `pyproject.toml` above `cwd` (the walk
stops at a `.git` boundary, so a stray `~/pyproject.toml` cannot capture a repo), so the
project's pinned ruff/ty/pytest apply and `uv.lock` is never rewritten as a side effect (plain
`uv run` re-locks when `pyproject.toml` drifted). uv's own failures (no lockfile, tool not in
the environment) are reported as such, not as findings. Calls on one project are serialized
through the shared lock; a waiting call says so. `NO_COLOR` and `UV_NO_PROGRESS` are set.
Every positional the model supplies (`paths`, `targets`, `select`, `packages`) must be a plain
value and goes after `--`; `-k`/`-m` travel as `-k=EXPR`.

- `py_lint {paths?, fix?, select?, limit?=50}`: `ruff check --output-format concise`; `fix`
  adds `--fix --ignore-noqa` (the Makefile gate's form) and reports `fixed`. States: `clean`,
  `findings` (exit 1), tool error (exit 2). One `path:line:col CODE [fixable] message` per
  finding; lines the parser does not recognise are kept under `unparsed` instead of dropped
- `py_format {paths?, mode: check|diff|apply}`: `ruff format --diff` for `check` (file list)
  and `diff` (plus the capped diff), write mode for `apply`. States `clean`, `would-reformat`,
  `reformatted`
- `py_typecheck {paths?, limit?}`: `ty check --output-format concise`, parsed as
  `file:line:col severity[rule] message`
- `py_test {targets?, k?, markers?, maxfail?=5, last_failed?, coverage?}`:
  `pytest --verbosity=-1 --tb=short -p no:cacheprovider --maxfail=N` (`--verbosity=-1` is
  absolute, so a project `addopts = "-q"` cannot hide the summary; `--lf` re-enables the cache
  plugin; `coverage` adds `--cov=src --cov-report=term-missing`). Exit codes map to `passed`,
  `failed`, `interrupted` (2, collection error), `usage-error` (4), `no-tests` (5, not an
  error). Only failures are listed, from the short summary, with the failure block below them;
  `stoppedEarly` says the run hit `--maxfail`. There is no `extra_args`: verbatim flags such as
  `--basetemp` or `-p` would let a read-only tool write, and Plan mode admits this tool
- `py_uv {action: sync|lock|add|remove, packages?, group?, dev?, all_extras?=true,
  all_groups?=true, locked?}`: `sync` defaults to `--all-extras --all-groups` (the Makefile
  uses `--all-extras`; groups are added so dev tools are present too); `locked` fails loudly on
  a stale lock

Annotations: `py_typecheck` and `py_test` are read-only and admitted in Plan mode. `py_lint`
and `py_format` carry a rewriting mode, so they are not (known cost: no lint or format check in
Plan mode; splitting the fix modes into their own tool would lift it); `py_uv` reaches the
network. All five are deferred by default (found via `search_tools`), per the always-active
budget.

## cargo

All nine run from the outermost `Cargo.toml` with `[workspace]` above `cwd` (else the nearest
manifest), default to `--all-features`, accept `package` (`-p`) and `toolchain` (`rustup run`),
set `CARGO_TERM_COLOR=never`, and serialize per workspace through the shared lock (keyed on
the workspace root, not the target dir); cargo's `Blocking waiting for file lock` line and
`Compiling` progress are relayed as updates. Every bare value the model supplies (`package`,
`features`, `bin`, ...) must be a plain identifier-ish token; `crates` for `cargo_add` may
also carry version requirements (`serde@^1`); filters only need to not start with `-`.
A relative `CARGO_TARGET_DIR` resolves against the workspace root; `build.target-dir` from
`.cargo/config.toml` is not consulted (junit and criterion lookups assume `target/`).

Compile diagnostics (`cargo_check`, `cargo_clippy`, `cargo_build`, `cargo_doc`) come from
`--message-format=json-diagnostic-short`: keyed on `reason`, errors and warnings only, deduped
on (level, code, primary span, message) because cargo emits one copy per target, with the
~900-char `code.explanation` dropped and the first `suggested_replacement` shown. One
`file:line:col: level[code]: message` per finding, errors first, capped by `limit`. States
`clean`, `warnings` (exit 0 but counted), `errors`. A non-zero exit with no compiler errors
(manifest error, missing toolchain) is a tool failure with cargo's stderr.

- `cargo_check {all_targets?=true}` mirrors `make check`
- `cargo_clippy {pedantic?=true, fix?, deny_warnings?}` mirrors `make lint`
  (`--all-targets --all-features -- -W clippy::pedantic`); `fix` adds
  `--fix --allow-dirty --allow-staged`
- `cargo_fmt {check?=true}`: `cargo fmt --all -- --check --color never` (rustfmt colours
  even when piped); `Diff in <file>:<line>:` blocks give the file list
- `cargo_test {filter?, no_fail_fast?=true, doc?=true, retries?, nocapture?}`: `cargo nextest
  run` with a `pi-dev-tools` profile layered UNDER the repo's own nextest config via `--tool-config-file`
  (repo retries, slow timeouts and groups still apply), junit parsed from
  `target/nextest/pi-dev-tools/junit.xml` (`<failure>` and `<error>` both count, flaky retries do not);
  then `cargo test --doc --no-fail-fast`, skipped (and said so) when a `filter` is set. A
  filterset expression (any of `( ) | & !` or a leading `not`) goes to `-E`, a bare string is
  a substring match.
  nextest's exits map to `passed`, `failed` (100), `no-tests` (4), `compile-error` (101).
  Passing tests are never listed; a doctest failure flips `passed` to `failed`
- `cargo_build {bin?, example?, release?}` returns the executables from `compiler-artifact`
- `cargo_run {bin?, example?, args?, stdin?, release?}`: stdin closed unless given, output
  capped; a non-zero exit is `nonzero-exit`, not a tool error, and only cargo's own
  `could not compile` counts as `compile-error` (a program may print `error:` and exit 101)
- `cargo_doc`: `--no-deps` with `RUSTDOCFLAGS=-D warnings`, like the docs gate
- `cargo_bench {bench?, filter?, save_baseline?, baseline?}`: reads criterion's
  `new/estimates.json` (ns) and `change/estimates.json` (fraction) written since the run
  started; baseline flags imply `--benches` because libtest harnesses reject them
- `cargo_add {crates, dev?, build?, features?, optional?, dry_run?}` reports `name@version`

Annotations: `cargo_check`, `cargo_test`, `cargo_doc` are read-only; `cargo_add` reaches the
network; the rest write the tree or `target/`. All nine are deferred (found via `search_tools`).

## Development

```
# From the monorepo root:
make install
npm run check --workspace @nredd/pi-dev-tools  # biome, tsc --noEmit, vitest, bun test test/scenarios
```

Harness gate before any tag: `HARNESS_LOCAL=pi-dev-tools make verify` in `~/code/pi-harness-e2e`.
Pin lives in chezmoi `third_party/pi-agent-settings.base.json`; see `~/.pi/agent/README.md`.

## Layout

- `src/core/` shared runner, output bounding, lock, result shaping
- `src/<group>/` one module per tool group, registered from `src/index.ts`
- `test/<group>/` vitest, `test/fixtures/<group>/` recorded real tool output
- `test/scenarios/` the extension inside a real `AgentSession` (`@earendil-works/pi-coding-agent/testing`):
  faux model tool calls, pi's validation, `tool_call` hooks, the real `bash` tool and result
  serialization. Run under Vitest and `bun test`, so they use no runner-specific API
