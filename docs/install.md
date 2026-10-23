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
- `<installer-sha>` is the exact commit of the installer code. Use the same SHA as `<stack-sha>` when that promotion contains `integration/harness/install.py`: then one pin covers both, and the installer passed the same promotion gates. `stack/24889f7896be7157bf9077a41465a3b29620879f` predates the installer, so for it use any `main` commit that has the installer.
- Add `--plan` to verify and print the plan without changing anything. Add `--yes` to agree to overwrites without a prompt.

Nothing is piped into a shell. `uv` fetches the pinned Git commit, so Git's object hashes bind the installer source to the SHA you typed. `--python` and `--exclude-newer` fix the interpreter and resolve the installer's Python dependencies (pydantic) as of a fixed instant instead of the newest release.

## What it installs

- The core release named by the snapshot (`stack.core.tag`, e.g. `v1.3.0-nredd.7`) into `~/.local/share/pi-stack/core/<tag>/`, with the same npm steps as the Homebrew formula (`harness.release.fetch_release`). Homebrew is never used, so a newer formula cannot replace the pinned core.
- A `pi` link in `~/.local/bin` (`--bin-dir` changes it). Add that directory to `PATH` if it is not already.
- Every package source in the snapshot's order, through that core's own `pi install`, into `~/.pi/agent/npm`.
- In `~/.pi/agent/settings.json`: `packages` set to the snapshot's exact declarations (resource filters kept as written, so the preset loads only its footer extension), plus the snapshot's `settings` keys (`quietStartup`, `fullscreen`). Every other key you have is kept.
- In `~/.pi/agent/subagents.json`: `packageAgents: false` when a source is filtered, because pi-subagents loads package agents outside Pi's filters. Other keys are kept.
- Disabled extensions (`disabled_extensions`, currently `@nredd/pi-computer-use`) are installed without npm lifecycle scripts and declared with `extensions: []`, so they are never loaded and their native helper is never built or launched.

`PI_CODING_AGENT_DIR` and `XDG_DATA_HOME` move the agent and installer directories exactly as they move Pi's.

## What you configure yourself

The installer never reads, copies or writes credentials or personal state. After installing:

- Log in: run `pi`, then `/login`, or set your own provider API keys.
- Choose default and enabled models and any router profiles.
- Add memory, MCP servers, personal prompts, skills or themes if you want them.
- `@nredd/pi-computer-use` stays off. Its macOS helper needs Screen Recording and Accessibility (TCC) permissions you grant yourself; Linux has no supported helper.

`auth.json`, `models.json`, sessions, memory and every other file in the agent directory are never touched. Machine-specific configuration (dotfiles, enterprise overlays) stays out of the snapshot by design.

## Verification, before any change

1. Platform and prerequisites, all reported at once.
2. `stack-snapshot.json` is downloaded from the `stack/<stack-sha>` release. Its attestation bundle comes from GitHub's public attestations API (no token), and `gh attestation verify --bundle` must accept it for repository `nredd/pi-harness`, signer workflow `nredd/pi-harness/.github/workflows/promote-stack.yml`, source ref `refs/heads/main`, hosted runners only. These are the consumer requirements in [stack promotion](stack-promotion.md#consumer-requirements).
3. The bytes are validated with `StackSnapshot` (schema, canonical `stack_sha256`) and `source_sha` must equal `<stack-sha>`. No other interpretation of the manifest exists: the installer reuses `harness.promotion` and `harness.stack`.
4. The core release identity is checked with `validate_release_identity`; each recorded asset is hashed, and attested by `nredd/pi`'s `fork-release.yml` for non-legacy tags. Legacy tags `v1.3.0-nredd.3` to `.7` predate that workflow and rely on the frozen digests in `harness/release.py`.
5. Node.js must satisfy the core's `engines.node` (read from the verified tarball; `>=22.19.0` for `v1.3.0-nredd.7`).

After staging, each installed package version must equal its pin, and each owned `@nredd/` package's npm lockfile integrity must equal the SHA-512 the promotion verified. Third-party packages are pinned to exact versions and fetched from `registry.npmjs.org` with an empty npm config; their tarballs are not independently attested.

A failed check exits before anything in your home changes.

## Prerequisites and platforms

- `uv` (to run the command), Git (for `uv` to fetch the pinned commit), `gh` (GitHub CLI, verification only, no login), Node.js meeting the core's engine, npm.
- Network access to `github.com`, `api.github.com`, the Sigstore TUF CDN that `gh` uses, and `registry.npmjs.org`.

Supported, because the real installer acceptance runs there: macOS on Apple silicon (`Darwin/arm64`) and Linux x86-64 (`Linux/x86_64`). Everything else, including Windows, WSL, Linux ARM64 and Intel macOS, is refused up front rather than guessed.

## Existing installations and consent

The installer prints the plan first: the packages in order with their filters, each `CREATE`, and each `OVERWRITE`. Creating things in a clean home needs no confirmation. Anything that replaces existing state needs consent: answer `y` at the prompt, or pass `--yes`. Without a terminal and without `--yes`, it exits `4` and changes nothing.

Overwrites include an existing `~/.pi/agent/npm` tree, changed `settings.json` keys, packages you declared that are not in the stack (they stop loading), `subagents.json`, and an existing `~/.local/bin/pi`. Everything replaced is moved or copied to `~/.local/share/pi-stack/backups/<UTC time>-<sha>/` first and kept.

A corrupt `settings.json` or `subagents.json` stops the run; fix or move it yourself.

## Reruns, updates, interruptions

- Rerunning the same SHA re-verifies the snapshot, finds nothing to change and exits `0`. Drift (a changed package version, a removed link, an edited `packages` list) is planned and repaired, with consent for overwrites.
- Update or roll back by running the command with another promoted SHA. There is no moving pointer and no `latest`. Do not use `pi update` or `pi install` for the managed packages: the next installer run puts the snapshot's declarations back.
- Everything is staged under `~/.local/share/pi-stack/staging/` first. A failure or interruption while staging leaves your home as it was. A verified core prefix may remain under `core/`; it is immutable and reused.
- The switch-over is journaled in `~/.local/share/pi-stack/transaction.json` before each step. A failure during the switch rolls back immediately. If the process is killed mid-switch, the next run restores every journaled step (after consent) and then installs. If a restore itself fails, the run says so and keeps the journal; the original files are in `backups/`.
- Only one installer runs at a time (`~/.local/share/pi-stack/lock`).

Exit codes: `0` installed or already installed, `1` failed (state unchanged or restored, as reported), `2` unsupported platform or missing prerequisite, `3` verification failed, `4` consent required or declined.

To uninstall: remove `~/.local/bin/pi`, `~/.local/share/pi-stack`, `~/.pi/agent/npm`, and the `packages` key of `~/.pi/agent/settings.json`, or restore from `backups/`.

## Testing

- Units, offline, against the real `stack/24889f7` snapshot bytes: `integration/tests/test_install.py` (part of `make check-integration`).
- Real acceptance, in throwaway HOMEs with real GitHub, `gh`, npm and core: `make -C integration installer INSTALLER_SPEC='git+https://github.com/nredd/pi-harness@<installer-sha>#subdirectory=integration' STACK_SHA=<stack-sha>`. It covers missing prerequisites, an unpromoted SHA, tampered bytes and foreign signer/ref against real `gh`, a fresh install compared with the snapshot (order, filtered preset, disabled computer-use, owned integrity, `pi --version`, `pi list`), a no-op rerun, consent with an existing setup whose credentials and unrelated settings survive, and a SIGKILL during staging followed by a successful rerun. `.github/workflows/installer.yml` runs it on `ubuntu-24.04` and `macos-14` from the exact commit, with no token.
