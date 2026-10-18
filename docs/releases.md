# Releases

- Generate `releases/<release-id>.json` with `make release-manifest ARGS='<release-id> ...'` after exact Gitlinks, package manifests, artifacts, and evidence are available.
- The schema-versioned manifest records the monorepo commit, Gitlink provenance, owned package versions, existing root lockfile digests, supplied artifact digests/URLs, and free-form verification evidence.
- It is generated, never a hand-edited fork-pin file. Refuse a dirty tree unless `--allow-dirty` deliberately records `release.dirty: true`. Generate it on the clean tree that already contains the generator, then commit it: the recorded `release.commit` is the manifest commit's parent, by construction.
- Deliberately omitted: profiles, runtime-tree archives, and a complete third-party resolution lock. Those inputs do not exist in this minimal slice yet.
- `2026-10-17-startup-trust`: core `v1.3.0-nredd.3` + `pi-subagents` `v0.22.0-nredd.2`. `2026-10-18-npm-publication`: first npm publication of the four owned packages, tarballs packed from `c1857f3` after `make check-package-contracts`, registry bytes re-downloaded and compared. No provenance attestation yet (no OIDC publisher).
