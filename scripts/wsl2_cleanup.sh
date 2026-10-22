#!/usr/bin/env bash
# Preserve bounded diagnostics while retaining the harness status in `wsl2.yml`.

cleanup_wsl2_worktree() {
  status=$?
  set +e
  if [ -n "$worktree" ] && [ -d "$worktree/integration/artifacts" ]; then
    mkdir -p "$diagnostics_dir/artifacts" || true
    cp -a "$worktree/integration/artifacts/." "$diagnostics_dir/artifacts/" \
      || printf 'WARNING: could not preserve WSL failure artifacts\n' >&2
  fi
  printf 'WSL harness exited with status %s.\n' "$status" >"$diagnostics_dir/capture-status.txt" \
    || printf 'WARNING: could not record WSL capture status\n' >&2
  rm -rf "$worktree" || printf 'WARNING: could not remove disposable WSL worktree\n' >&2
  return "$status"
}
