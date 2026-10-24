# npm provenance fixture

`vite-7.1.3-provenance.json` was fetched on 2026-10-19 from
https://registry.npmjs.org/-/npm/v1/attestations/vite@7.1.3.

- Keep the original SLSA v1 DSSE payload, content type and signature.
- Omit the unrelated npm publish receipt and the certificate/transparency-log verification material.
- Test parsing and source/subject binding only. The trimmed fixture cannot prove cryptographic validity;
  production delegates that to `npm audit signatures` against the registry in a throwaway project.
- Adapt the decoded subject, workflow and source to the owned release fixture in tests, then re-encode.
  Those synthetic payloads are deliberately not claimed to have valid signatures.

# Merge-helper fixture

`merge-pr-135.json` is a projected real GitHub REST/CLI capture from 2026-10-24, not invented CI state.

Sources:
- `gh pr checks 135 --repo nredd/pi-harness --json name,state,link`
- `GET repos/nredd/pi-harness/pulls/135`
- `GET repos/nredd/pi-harness/rules/branches/main`
- `GET repos/nredd/pi-harness/commits/df3e579db6021606687f8a4620dff67b95d49bbb/check-runs?filter=latest&per_page=100`
- `GET repos/nredd/pi-harness/actions/runs?head_sha=df3e579db6021606687f8a4620dff67b95d49bbb&per_page=100`
- `GET repos/nredd/pi-harness/actions/runs/{40072686016,40072686131}` and their `/jobs?per_page=100`
- `GET repos/nredd/pi-harness/check-suites/{108617921328,108617921622}`

Projection keeps only evidence used by the gate plus capture timestamps. Actor, commit-message, repository metadata and unused step timing fields are omitted. Step names/status/conclusions are retained; zero-step cancelled jobs are unchanged. Tests split these real records over synthetic pages, reverse run ordering and mutate one property at a time for negative cases. The two CI runs were created in the same second; run numbers `435` and `436`, not timestamps, establish order. The legacy flattened predicate rejects exactly three unexpanded cancelled template names despite nine successful required contexts.

Replay offline: `uv run --locked --project integration pytest scripts/tests/test_merge_pr_checks.py -c scripts/pyproject.toml`.
