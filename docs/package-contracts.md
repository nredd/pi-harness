# Package contracts

`make check-package-contracts` proves the three plugin tarballs work alone against exact stock Pi.
It is explicit and separate from `make check`: it needs the npm registry on first use (to install
stock Pi) and runs real Pi processes. The tooling itself (`scripts/package_contracts.py`,
`scripts/faux_provider.py`) is unit tested by `make check-scripts`.

Pinned identity (constants in `scripts/package_contracts.py`, never "latest"):

- Stock Pi: `@earendil-works/pi-coding-agent@1.3.0`, integrity
  `sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==`
- Installed with `npm install --ignore-scripts` into `~/code/pi-harness-builds/tools/pi-stock-1.3.0`
  (override with `--stock-prefix`), outside the source tree and reused. A mismatched lockfile
  integrity or `pi --version` fails the gate
- `--report FILE` (`make check-package-contracts REPORT=/abs/file.json`) records Pi, Node, npm, the
  `LICENSE` digest, and per package the version, tarball name, `sha512` integrity, `sha1`, size,
  file list and scenario evidence

What each package must satisfy:

- `npm pack` contents match a narrow allowlist: `src/`, `LICENSE`, `README.md`, `package.json`, plus
  `CHANGELOG.md` (router) and `dist/pi-stats-export.mjs` + `docs/stats-snapshots.md` (session-kit).
  Tests, fixtures, `e2e/`, lint/TS/vitest config and planning docs must not ship. Before this change
  none of the tarballs had a `LICENSE` and all shipped `test/` plus dev config
- Packed `LICENSE` is byte-identical to the root `LICENSE`
- Manifest: `private: true` (kept until the namespace/OIDC prerequisites exist), `MIT`, no
  `dependencies`/optional/bundled, peers only from the Pi host set (`@earendil-works/pi-ai`,
  `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) with range `*`, `pi.extensions` present
- Every import is a `node:` builtin, a host module, or a relative path inside the package. No
  `@nredd/*` sibling. The stats artifact may import only `node:` builtins
- Fresh install (`--ignore-scripts --legacy-peer-deps --offline`, mirroring Pi's suppressed peer
  installs): `node_modules` and the lockfile contain only the package, so no duplicate host copy
- Stock Pi, `--mode json` with `--no-extensions --extension <installed dir>` (only that package),
  `--no-mcp`, `--offline`, no skills/templates/themes/context files, `--no-approve`:
  - dev-tools: a real `git_status` result on a disposable repo (`untracked.txt`), and an error result
    outside a repository
  - session-kit: real `monitor_start`/`monitor_read` output, then `dist/pi-stats-export.mjs` run with
    only `node` from an unrelated directory exporting that real session and importing it elsewhere;
    unknown flags exit nonzero
  - subscription-router: `router/default` is listed and a request dispatches to the physical
    `local/m`; an invalid config registers nothing and does not crash Pi
  - in every run the package's tools are declared and no other package's are (sibling absent)

Isolation: the child environment is built from scratch, never inherited. `HOME`, `TMPDIR`/`TMP`/`TEMP`,
`XDG_*`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and the npm cache/config all live in a per-package
scratch directory (session-kit sweeps `os.tmpdir()` on startup, so nothing points at shared temp
state). No provider keys or loader variables (`NODE_OPTIONS`, ...) reach children; `HTTP(S)_PROXY`
points at a dead port with loopback excluded as defense in depth for clients honoring proxy
variables. This is not a network sandbox: direct sockets and clients ignoring those variables are
not intercepted. The only configured model is a loopback scripted provider (`faux_provider.py`)
registered through `models.json` with a dummy key.
Scratch is deleted unless `--keep`.

Limits: this is stock Pi only. It does not exercise `pi install npm:...` (nothing is published),
the forked subagents/Plan-mode integrations, the Bun-compiled candidate, or the full stack. Do not
read a pass as candidate or fullstack acceptance.
