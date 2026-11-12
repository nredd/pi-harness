# Transcript timestamp integration

`integration/inprocess/transcript.test.ts` retains the default-OFF one-line/framing oracles
and adds the native `showTimestamps` path with real todo and subagent renderers at 80x24 and
120x40. It enables the setting through `/settings`, uses recorded parent call-context times,
expands a child row, toggles timestamps without collapsing it, exercises `Ctrl+O`, reloads,
and resizes. Exact viewer-local fixture labels are asserted in their owning entry's leading
rule, ignoring only renderer-owned blank padding. A taller expanded viewport counts every timestamp label, including current-time
values, so nested child details cannot receive another core timestamp unnoticed.

Core nredd/pi#32 (issue nredd/pi#30) is merged at
`ee059aa4050a221a83dae782f4575b1258e84b45`. Authorized release coordination in
[#774](https://github.com/nredd/pi-harness/issues/774) combines these tests from #767 with
#754's compaction child verification. The selected `.10` released host still lacks the
setting, so these tests intentionally fail with an explicit release-prerequisite assertion.
Do not skip them, add feature-detection fallback, spoof release identity or replace the pinned
host in committed test configuration. Before admission, the coordinated train must select the
authenticated release coherently across its Gitlink, dependencies, overrides, locks and stack.

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
