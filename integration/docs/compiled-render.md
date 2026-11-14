# Compiled render qualification

Issue #628 remains open until a quiet-runner benchmark receipt and native Linux ARM64
acceptance exist. No budget or baseline changes are authorized by this instrumentation.

`tests/test_compiled_render.py` compiles the real `probes/render.ts` handler into a tiny Bun
executable with a synthetic TUI and command registry. With no runtime options it wraps and
calls the real `Bun.gc(true)` synchronously; with `BUN_OPTIONS=--expose-gc` it proves the
`global.gc` route. A throwing collector must exit nonzero without publishing a heap record.
This proves instrumentation only, not the compiled Pi extension loader, rendering correctness,
frame performance, or native Linux ARM64 support. No synthetic timings are benchmark samples.

Each real render record includes `gc_method` (`global.gc`, `Bun.gc(true)`, or `none`) and
`runtime` (`engine`, `version`, `platform`, `arch`). The existing `gc` boolean remains compatible.
These fields describe the executing engine, not whether its executable is compiled. Preserve
the executable digest and invocation separately. A failed collection writes no record.

Quiet-runner request (parent owns scheduling and execution):

- Use a separately qualified, idle native runner and the immutable selected core artifact.
  Do not rebuild or replace immutable release artifacts. Record why the runner was quiet,
  CPU/OS/architecture, Bun version, harness commit, core commit/tag, binary SHA-256, stack
  document SHA-256 and installed `stack-evidence.json` identities. Never use the live install.
- Run serially with disposable HOME and credential-free fixture environments through the
  harness. Set explicit `PI_BIN` to the standalone, not a Node wrapper. Preserve stdout,
  stderr, JUnit, raw probe JSONL and baseline comparison verdicts, including failures.
- Invoke `make -C integration bench STACK=stacks/personal.json RUNTIME=bun-standalone`
  with `PI_BIN` exported and the existing quiet-runner admission satisfied. Repeat for
  `stacks/local.json`. This selects all existing `scenarios/bench` cases, not just render;
  it does not update baselines. Coordinate startup timing with #577's sole owner.
- For fallback qualification, invoke the render cases directly with `--runtime bun-standalone`
  and an explicit fixture launch without GC options; retain a record with
  `gc_method=Bun.gc(true)`. Normal `probe_args` requests exposed GC through both runtime
  option variables, so its normal result may instead be `global.gc`.
- Run the same full benchmark selection on a native Linux ARM64 standalone. Record the
  artifact's provenance and native architecture; an x64 emulator or a tiny compiled test
  fixture does not qualify this cell. No runner activation or infrastructure changes are
  included here.
- Compare `ms_input_p95_n4` against the unchanged existing limit. The prior loaded-host
  11.4-12.5ms samples do not justify a Bun-specific budget. Report any failure unchanged;
  optimization or budget disposition requires the actual quiet-runner evidence first.

Current acceptance: compiled instrumentation fixture TESTED by the unit gate; compiled Pi
render/performance, quiet-runner benchmarks and native Linux ARM64 acceptance UNMEASURED.
The PR must reference #628 without closing it solely from fixture results.
