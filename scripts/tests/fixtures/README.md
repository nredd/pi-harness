# npm provenance fixture

`vite-7.1.3-provenance.json` was fetched on 2026-10-19 from
https://registry.npmjs.org/-/npm/v1/attestations/vite@7.1.3.

- Keep the original SLSA v1 DSSE payload, content type and signature.
- Omit the unrelated npm publish receipt and the certificate/transparency-log verification material.
- Test parsing and source/subject binding only. The trimmed fixture cannot prove cryptographic validity;
  production delegates that to `npm audit signatures` against the registry in a throwaway project.
- Adapt the decoded subject, workflow and source to the owned release fixture in tests, then re-encode.
  Those synthetic payloads are deliberately not claimed to have valid signatures.
