# Release tools

The `pi-harness-release` uv project owns the installer, verified release transport, runtime
locks, stack schemas, promotion and publication checks. Product modules live in `pi_release/`;
`stacks/` holds declared stacks and runtime locks. It never imports test harness internals.

Install a reviewed source commit:

```sh
uvx --from 'git+https://github.com/nredd/pi-harness@<sha>#subdirectory=release' pi-stack-install --help
```

Old SHA-pinned `#subdirectory=integration` URLs continue to resolve their original trees.
The move changes no published stack, package version, schema, canonical digest or provenance
identity. Promotion remains in `.github/workflows/promote-stack.yml` on `main`, on hosted
runners; tags remain `stack/<source_sha>` and snapshots remain `stack-snapshot.json`.

Run `uv sync --locked --project release` to install the product project. Root
`make check-integration` executes all existing unit tests in `tests/integration/tests/`,
measuring `harness` and `pi_release` independently at 100% line and branch coverage. Scenarios,
providers, probes, goldens and historical baselines stay under `tests/integration/`.

## Development bundles

From an initialized checkout with `make install-owned` completed:

```sh
uv run --locked --project release pi-dev-bundle --root . --output ../dev-bundle
node ../dev-bundle/core/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version
```

The destination must not exist and must be outside the source checkout. The command builds
all owned packages, including the computer-use `make bridge` target (both macOS architectures;
explicit no-op elsewhere). Core must be clean and match the `forks/pi` Gitlink. Like `Fork release`,
it installs core dependencies with scripts disabled, restores model data from the matching
published `pi-ai` version, runs `build:offline`, and packs coding-agent, tui, agent and ai.
It does not run the release gate, attest, publish, tag, pin or activate anything. Package scripts
execute trusted checkout code. This is development output, never release evidence.

`manifest.json` is written only after every build, tarball audit and core runtime installation
succeeds; failures discard staging output. Its version-1 contract is:

- `schema_version`: `1`
- `source_sha` and `core_sha`: checkout HEAD and verified core Gitlink commit
- `packages`: package-name keyed object, including all `@nredd/` packages and the four core packages
- Each package has `tarball` (bundle-relative), `extensions` (normalized package-relative
  `pi.extensions` entries read from the actual tarball), and `filter_mapping` (legacy selector
  -> current extension path). Every extension must be a packed regular file or a directory
  with a packed `index.ts`; absent, unsafe and malformed entries fail closed
- The preset maps `extensions/expanded-footer.ts` -> `src/index.ts`. Consumers map only explicit
  extension selectors through this table; retain empty arrays and all other resource filters.
  Never replace a filtered source with an unrestricted package string
- `core_bin`: bundle-relative runnable CLI; invoke with Node. The `core/` runtime installs the
  four local tarballs using matching overrides, so their registry versions cannot replace them

Consumers own checkout/ref acquisition, installing selected tarballs and atomic activation or
rollback. Resolve paths relative to the manifest, not package source layout. Activation integration
is a separate consumer follow-up; this command does not read or write settings or active state.
