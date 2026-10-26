# Installing a promoted stack

`pi-stack-install` installs one promoted, attested `stack/<sha>` release into your own Pi home. It does not need chezmoi, these dotfiles, Homebrew or a GitHub login. Code: `integration/harness/install.py`.

## Command

Pick a promoted SHA from the `stack/*` releases [here](https://github.com/nredd/pi-harness/releases), then run:

```sh
uvx --python 3.13 --exclude-newer 2026-10-23T00:00:00Z \
  --from 'git+https://github.com/nredd/pi-harness@<installer-sha>#subdirectory=integration' \
  pi-stack-install <stack-sha>
```

- `<stack-sha>` is the promoted commit you install.
- `<installer-sha>` must be an exact, published `main` commit containing the installer, never an unmerged PR or candidate SHA. Use the same SHA as `<stack-sha>` when that promotion contains `integration/harness/install.py`: then one pin covers both, and the installer passed the same promotion gates. `stack/24889f7896be7157bf9077a41465a3b29620879f` predates the installer, so for it use any `main` commit that has the installer.
- Add `--plan` to verify and print the plan without changing anything. Add `--yes` to agree to overwrites without a prompt.

Nothing is piped into a shell. `uv` fetches the pinned Git commit, so Git's object hashes bind the installer source to the SHA you typed. `uv` also initializes that commit's `forks/pi` submodule (the core source, unused by the installer) and caches the checkout, so the first run downloads more than it needs. `--python` and `--exclude-newer` fix the interpreter and resolve the installer's Python dependencies (pydantic) as of a fixed instant instead of the newest release.

## What it installs

- The core release named by the snapshot (`stack.core.tag`, e.g. `v1.3.0-nredd.7`) into `~/.local/share/pi-stack/core/<tag>/`, with the same npm steps as the Homebrew formula (`harness.release.fetch_release`). Homebrew is never used, so a newer formula cannot replace the pinned core.
- A `pi` link in `~/.local/bin` (`--bin-dir` changes it). Add that directory to `PATH` if it is not already.
- Every package source in the snapshot's order, through that core's own `pi install`, into `~/.pi/agent/npm`.
- In `~/.pi/agent/settings.json`: `packages` set to the snapshot's exact declarations (resource filters kept as written, so the preset loads only its footer extension), plus the snapshot's `settings` keys (`quietStartup`, `fullscreen`). Every other key you have is kept.
- In `~/.pi/agent/subagents.json`: `packageAgents: false` when a source is filtered, because pi-subagents loads package agents outside Pi's filters. Other keys are kept.
- Disabled extensions (`disabled_extensions`, currently `@nredd/pi-computer-use`) are installed without npm lifecycle scripts and declared with `extensions: []`, so they are never loaded and their native helper is never built or launched.

`PI_CODING_AGENT_DIR` and `XDG_DATA_HOME` move the agent and installer directories as they move Pi's. `PI_CODING_AGENT_DIR` gets Pi's own tilde rule: a leading `~` or `~/` means your home directory, and nothing else is expanded (not `~user`, not `$VAR`). Pi also accepts a `file://` URL there; the installer refuses one (exit `2`, nothing changed) rather than reimplement Node's `fileURLToPath`, so set the plain path. `XDG_DATA_HOME` is taken as written, per the XDG spec (an absolute path).

## What you configure yourself

The installer never reads, copies or writes credentials or personal state. After installing:

- Log in: run `pi`, then `/login`, or set your own provider API keys.
- Choose default and enabled models and any router profiles.
- Add memory, MCP servers, personal prompts, skills or themes if you want them.
- `@nredd/pi-computer-use` stays off. Its macOS helper needs Screen Recording and Accessibility (TCC) permissions you grant yourself; Linux has no supported helper.

`auth.json`, `models.json`, sessions, memory and every other file in the agent directory are never touched. Machine-specific configuration (dotfiles, enterprise overlays) stays out of the snapshot by design.

## Verification, before any change

1. Platform and prerequisites, all reported at once.
2. `stack-snapshot.json` is downloaded from the `stack/<stack-sha>` release. Its attestation bundle comes from GitHub's public attestations API (no token), and `gh attestation verify --bundle` must accept it for repository `nredd/pi-harness`, signer workflow `nredd/pi-harness/.github/workflows/promote-stack.yml`, source ref `refs/heads/main`, hosted runners only. These are the consumer requirements in [stack promotion](stack-promotion.md#consumer-requirements). GitHub limits anonymous API use to 60 requests an hour per IP address; when that refuses the lookup, `gh attestation verify` is retried without `--bundle`, so `gh` fetches the attestation with its own login (`gh auth login` or `GH_TOKEN`). The installer never reads a token; without a login the rate limit is a verification failure. A `GH_TOKEN` in your environment is necessarily inherited by `uvx`, `uv`, the Git that fetches the installer, and the installer process (none of which use it). The installer passes GitHub token variables (`GH_TOKEN`, `GITHUB_TOKEN` and their enterprise forms) only to `gh attestation verify` when it must fetch without a bundle, and strips them from every other child: `gh` with a local bundle, `node`, `npm`, `pi install` and the `pi --version` check.
3. The bytes are validated with `StackSnapshot` (schema, canonical `stack_sha256`) and `source_sha` must equal `<stack-sha>`. No other interpretation of the manifest exists: the installer reuses `harness.promotion` and `harness.stack`.
4. The core release identity is checked with `validate_release_identity`; each recorded asset is hashed, and attested by `nredd/pi`'s `fork-release.yml` for non-legacy tags. Legacy tags `v1.3.0-nredd.3` to `.7` predate that workflow and rely on the frozen digests in `harness/release.py`. The snapshot must record both installed tarballs (`pi-coding-agent`, `pi-tui`), and staging downloads the core again, so those bytes are checked against the snapshot's digests (`harness.release.verify_asset`), never a re-read `SHA256SUMS`. NOT YET VERIFIED for real: no non-legacy core release exists (the newest, `v1.3.0-nredd.7`, is legacy), so the real acceptance only exercises the frozen-digest path. Non-legacy provenance (`nredd/pi`, `fork-release.yml`, `refs/tags/<tag>`, hosted runners only) is covered by units and by the same `gh attestation verify` primitive the snapshot check runs for real.
5. Node.js must satisfy the core's `engines.node` (read from the verified tarball; `>=22.19.0` for `v1.3.0-nredd.7`).

After staging, each installed package version must equal its pin, and each owned `@nredd/` package's npm lockfile integrity must equal the SHA-512 the promotion verified. Third-party packages are pinned to exact versions and fetched from `registry.npmjs.org` with an empty npm config; their tarballs are not independently attested. Transitive dependencies (of the core and of every package) are NOT pinned by the snapshot: npm resolves them from the registry at install time within each package's declared ranges, so two installs of one SHA can differ below the pinned top-level versions.

A failed check exits before anything in your home changes.

## Prerequisites and platforms

- `uv` (to run the command), Git (for `uv` to fetch the pinned commit), `gh` (GitHub CLI with `gh attestation verify`; no login unless the anonymous rate limit is hit), Node.js meeting the core's engine, npm.
- Network access to `github.com`, `api.github.com`, the Sigstore TUF CDN that `gh` uses, and `registry.npmjs.org`.

The installer directory (`XDG_DATA_HOME`), the agent directory (`PI_CODING_AGENT_DIR`) and the link directory (`--bin-dir`) must be on one filesystem, including the installer directory's own `staging`, `backups` and `core` subdirectories if you mounted any of them separately: the switch-over renames staged trees and backups between them. Otherwise the run exits `2` before anything changes.

Supported, because the real installer acceptance runs there: macOS on Apple silicon (`Darwin/arm64`) and Linux x86-64 (`Linux/x86_64`). Everything else, including Windows, WSL, Linux ARM64 and Intel macOS, is refused up front rather than guessed. WSL reports `Linux/x86_64`, so it is detected physically (`harness.paths.is_wsl`, `/proc/version`) and refused before any install step, with no flag to bypass it. Restoring an interrupted switch's journal (below) needs no prerequisites and still runs first.

Each tool is run from the path `PATH` found it at, never from what a link there resolves to: version managers such as Volta or mise link `node` to one dispatcher that picks the runtime by its own name.

## Existing installations and consent

The installer prints the plan first: the packages in order with their filters, each `CREATE`, and each `OVERWRITE`. Creating things in a clean home needs no confirmation. Anything that replaces existing state needs consent: answer `y` at the prompt, or pass `--yes`. Without a terminal and without `--yes`, it exits `4` and changes nothing.

Overwrites include existing `~/.pi/agent/npm` and `~/.pi/agent/git` trees (both are replaced and backed up, even when the stack installs no git package), changed `settings.json` keys, packages you declared that are not in the stack (they stop loading), `subagents.json`, and an existing `~/.local/bin/pi`. Everything replaced is moved or copied to `~/.local/share/pi-stack/backups/<UTC time>-<sha>/` first and kept.

Every path is classified with `lstat` before it is opened, so a FIFO, socket or device is refused instead of read (a FIFO would block the run forever). Accepted kinds, per path:

- `settings.json`, `subagents.json`: a regular file, or a link to one, which is read through. A link that would change is refused (exit `1`): an atomic replace would turn your link into a regular file. A dangling link counts as absent, so it is refused the same way when the plan writes the file. Any other kind, including a link to one, exits `2`.
- `installed.json`: a regular file only. A link is never followed and, like any other kind, exits `2`.
- `~/.pi/agent/npm`, `~/.pi/agent/git`: a directory or a link.
- `~/.local/bin/pi`: a regular file or a link.
- Installed `package.json` manifests: regular files or links to regular files, read nonblocking and checked again after opening. A missing, invalid or special manifest makes the package set require repair, never a blocking read.
- `core/<tag>`: a directory or a link, backed up when replaced. Other kinds exit `2` before staging.
- `backups` (the store under the installer directory): a real directory, or absent. A link or any other kind exits `2` before the prompt and before anything changes. The switch opens the store and its per-run directory with `O_NOFOLLOW | O_DIRECTORY`; backup renames are relative to the held directory descriptor, never a later symlink lookup. Directory identities are checked during the switch and before commit. A store swapped after the final pre-switch check is refused; a later swap cannot redirect backup writes, and a failed recovery keeps its journal.
- `lock`: an owned regular file, not writable by group or others. Links and special files exit `2`; opening is nonblocking, never follows a final link and never truncates existing bytes. The opened descriptor is checked before `flock`. A lock left group-writable by an earlier build running under `umask 002` is refused the same way (exit `2`, nothing changed): run `chmod g-w ~/.local/share/pi-stack/lock` once, then rerun. The installer never loosens or rewrites a lock itself.
- `transaction.json`: see the journal below.

A corrupt `settings.json` or `subagents.json` stops the run (exit `1`); fix or move it yourself. Refusals by kind happen before the prompt and before anything changes; move the entry aside yourself. A path that turns into a refused kind after planning is refused before it is journaled: the switch fails, rolls back the steps it already took and exits `1`.

## Reruns, updates, interruptions

- Rerunning the same SHA re-verifies the snapshot and finds nothing to change. It still runs `pi --version` through the link: an install that matches but does not run exits `1` instead of reporting `Already installed`, and changes nothing. A core prefix whose `pi-stack-core.json` marker matches the snapshot is never reinstalled, so when `pi --version` fails with that core kept (here, or after a switch that left it in place), the error names `~/.local/share/pi-stack/core/<tag>`: if it is damaged, remove it and rerun to reinstall it. Otherwise it exits `0`. Drift (a changed package version, a package manifest or npm lockfile entry that is missing or malformed, a removed link, an edited `packages` list) is planned and repaired, with consent for overwrites.
- Update or roll back by running the command with another promoted SHA. There is no moving pointer and no `latest`. Do not use `pi update` or `pi install` for the managed packages: the next installer run puts the snapshot's declarations back.
- During switch-over, originals (including settings files) are renamed into the anchored backup directory before replacements land. The multi-path switch is not atomic: an interruption between those operations can leave a target absent until the next consented journal recovery. Rename preserves the original entry's metadata and uses the same descriptor-relative primitive for files, links and trees.
- Everything is staged under `~/.local/share/pi-stack/staging/` first. A failure or interruption while staging leaves your home as it was. The replacement core stays in staging while packages install, so a live link to an existing core remains untouched on staging failure. The core moves into `core/<tag>` only during the journaled switch; any old prefix is backed up first.
- The switch-over is journaled in `~/.local/share/pi-stack/transaction.json` before each step. A failure during the switch, or a `pi --version` through the new link that does not run (checked before the journal commits), rolls back immediately. If the process is killed mid-switch, the next run restores every journaled step (after consent) first, offline: the restore needs no network, no prerequisites and no snapshot, so it completes even if verification then fails. The journal is created owner-only (`0600`) before any data is written, whatever your umask. It is trusted only if it is a regular file you own with no group or other permission bits (`0600`, or `0400` if you made it read-only) and every step names a path a switch replaces (`npm`/`git` trees, `settings.json`, `subagents.json`, the `pi` link, `installed.json`, exact versioned `core/<tag>` prefixes) with its backup, of the kind that path holds, inside one `backups/<run>/` directory; anything else fails closed before a single file changes. The journal names the exact paths of the run that wrote it, so restore with that run's `--bin-dir` and `PI_CODING_AGENT_DIR` (and `XDG_DATA_HOME`, which locates the journal); with other ones the steps fall outside the allowed paths and the run fails closed, saying so. A dangling `npm`/`git` tree or core link counts as existing state, so replacing it needs consent. `--plan` lists the pending `RESTORE` steps, exits `0`, and plans nothing until the restore has run. If a restore itself fails, the run says so and keeps the journal; the original files are in `backups/`. A missing expected backup is ambiguous (the step may not have started, may already have been restored, or its backup may have been lost): recovery validates every expected backup before deleting any live target and fails loudly, keeping the journal for manual recovery, rather than assuming the step never started. This conservative refusal also applies to older journals.
- Only one installer runs at a time (`~/.local/share/pi-stack/lock`).

Exit codes: `0` installed or already installed, `1` failed (state unchanged or restored, as reported), `2` malformed stack SHA or arguments (usage), unsupported platform, split filesystems, an existing entry of a refused kind (before anything changes) or missing prerequisite, `3` verification failed, `4` consent required or declined.

To uninstall: remove `~/.local/bin/pi`, `~/.local/share/pi-stack`, `~/.pi/agent/npm`, and the `packages` key of `~/.pi/agent/settings.json`, or restore from `backups/`.

## Tracked follow-ups

- UNVERIFIED: exception tails containing `gh`/npm output may log sensitive child diagnostics; audit/redaction remains a follow-up, not a claimed fix.
- UNVERIFIED: parent-directory fsync and journal/backup durability across a power loss mid-switch remain a follow-up; file-content fsync is not proof of durable directory entries.

## Testing

- Units, offline, against the real `stack/24889f7` snapshot bytes: `integration/tests/test_install.py` (part of `make check-integration`).
- Real acceptance, in throwaway HOMEs with real GitHub, `gh`, npm and core: `make -C integration installer INSTALLER_SPEC='git+https://github.com/nredd/pi-harness@<installer-sha>#subdirectory=integration' STACK_SHA=<stack-sha>`. It covers missing prerequisites, an unpromoted SHA, tampered bytes and foreign signer/ref against real `gh`, a fresh install compared with the snapshot (order, filtered preset, disabled computer-use, owned integrity, `pi --version`, `pi list`), a no-op rerun, consent with an existing setup whose credentials and unrelated settings survive, and a SIGKILL during staging followed by a successful rerun. The staging marker wait has a 1200-second deadline and one-MiB output limit; success, EOF and timeout all kill the child process group and reap its leader. Cleanup has a separate 60-second deadline and checks for live group members with `/bin/ps`, repeating SIGKILL when a concurrent fork survives the first signal. It keeps the leader unreaped as the process-group ownership anchor until signalling finishes, then reaps it within the remaining deadline. It fails closed if a live member remains, so the rerun cannot delete staging under an orphaned npm writer; unreaped zombies cannot write and do not block it. macOS answers `EPERM` to a signal sent at a group that holds only zombies; that is accepted only when `/bin/ps` shows no live member, and `EPERM` with a live member still fails. A marker failure and cleanup failures are reported together, preserving the marker failure first. Offline subprocess coverage includes an externally supervised fork-at-signal writer that accepts a write request only after cleanup returns. The test leader and writers arm independent hard lifetimes before the marker and before blocking for requests, so regression failure cleanup never signals a potentially recycled PID/PGID. `.github/workflows/installer.yml` runs it on `ubuntu-24.04` and `macos-14` from the exact commit. Hosted runner IPs share GitHub's anonymous 60 requests/hour limit, so `main` pushes/dispatches and trusted same-repo pull requests (`head.repo.full_name == github.repository`) provision a temporary `gh` login using the read-only job token (`contents: read`, `attestations: read`, all other permissions disabled). A separate step pipes the token to `gh auth login`; acceptance uses a gh-only config shim. `make`/pytest receive only the nonsecret `INSTALLER_GH_CONFIG_DIR` path, not a token. Only the shim sets `GH_CONFIG_DIR` for `gh`; neither variable nor token reaches `uvx`, Git, package builds or other installer children. An always-running cleanup removes the temporary login. Fork pull requests and non-main dispatches remain anonymous and fail honestly when the limit refuses them. Same-repo authors are trusted, not fork-sandboxed; see the trust assumption in [CI](ci.md).
