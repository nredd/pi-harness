# Transcript timestamp integration

`integration/inprocess/transcript.test.ts` retains the default-OFF one-line/framing oracles
and adds the native `showTimestamps` path with real todo and subagent renderers at 80x24 and
120x40. It enables the setting through `/settings`, uses recorded parent call-context times,
expands a child row, toggles timestamps without collapsing it, exercises `Ctrl+O`, reloads,
and resizes. Nested child details do not receive another core timestamp.

This test change depends on nredd/pi#30 and an authorized core release containing it. The
selected released host does not yet have the setting, so the new tests intentionally fail
with an explicit release-prerequisite assertion. Do not skip them, add a feature-detection
fallback, spoof release identity, or replace the pinned host in committed test configuration.
No release, version, stack, package override, lockfile, or Gitlink changes are included here.

Gates from the integration workspace:

```sh
npm run lint
npm run typecheck
node ../../scripts/run-vitest.ts node transcript.test.ts --maxWorkers=1
node ../../scripts/run-vitest.ts bun transcript.test.ts --maxWorkers=1
```

`make verify-root-overrides` must continue to verify real released-core identities. A local
source-candidate developer probe is useful before release but is not this gate, CI evidence,
or permission to merge this dependent change. Parent release/pin ownership must resolve the
prerequisite in a separately authorized change, then run the unchanged gates on exact HEAD.
