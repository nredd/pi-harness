# Releases

- Generate `releases/<release-id>.json` with `make release-manifest ARGS='<release-id> ...'` after exact Gitlinks, package manifests, artifacts, and evidence are available.
- The schema-versioned manifest records the monorepo commit, Gitlink provenance, owned package versions, existing root lockfile digests, supplied artifact digests/URLs, and free-form verification evidence.
- It is generated, never a hand-edited fork-pin file. Refuse a dirty tree unless `--allow-dirty` deliberately records `release.dirty: true`. Generate it on the clean tree that already contains the generator, then commit it: the recorded `release.commit` is the manifest commit's parent, by construction.
- Deliberately omitted: profiles, runtime-tree archives, and a complete third-party resolution lock. Those inputs do not exist in this minimal slice yet.
