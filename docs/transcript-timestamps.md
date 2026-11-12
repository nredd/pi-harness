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
#754's compaction child verification. This train now selects authenticated
`v1.3.0-nredd.11` at `640d64bcd4da08231232b5c08acd48b88ee1fd45` coherently across its
Gitlink, dependencies, overrides, locks and stack. The earlier `.10` host intentionally failed
the explicit release-prerequisite assertion because it lacked the setting; that preparation
failure is historical, not the current gate result. Do not skip the assertions, add feature-detection
fallback, spoof release identity or replace the pinned host in committed test configuration.

Gates from the integration workspace:

```sh
npm run lint
npm run typecheck
node ../../scripts/run-vitest.ts node transcript.test.ts --maxWorkers=1
node ../../scripts/run-vitest.ts bun transcript.test.ts --maxWorkers=1
```

`make verify-root-overrides` must continue to verify real released-core identities. A local
source-candidate developer probe is useful before release but is not this gate, CI evidence,
or permission to merge this dependent change. Publication resolved the release prerequisite;
the unchanged gates still run on the artifact-backed exact HEAD before parent merge admission.
Combined verification, promotion and live activation remain separate.
