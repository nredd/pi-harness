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
