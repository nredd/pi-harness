#!/usr/bin/env bash
# Shared Ubuntu mirror selection, apt fetch phases and command deadlines.
apt_label=ubuntu-apt
apt_on_timeout=:
apt_capture=
packages=()

apt_bounded() {
  local label=$1 seconds=$2 status=0 log_status=0
  shift 2
  if [ -n "${apt_log:-}" ]; then
    # A descendant can keep writing after apt exits. Replay a regular file, not a pipe.
    timeout --kill-after=10 "$seconds" "$@" > "$apt_capture" 2>&1 || status=$?
    tee -a "$apt_log" < "$apt_capture" || log_status=$?
    if [ "$log_status" -ne 0 ]; then
      printf '%s: could not append to %s (status %s)\n' "$apt_label" "$apt_log" "$log_status" >&2
      [ "$status" -ne 0 ] || status=$log_status
    fi
  else
    timeout --kill-after=10 "$seconds" "$@" || status=$?
  fi
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf '%s: TIMEOUT: %s exceeded %ss: %s\n' "$apt_label" "$label" "$seconds" "$*" >&2
    "$apt_on_timeout" || true
  elif [ "$status" -ne 0 ]; then
    printf '%s: FAILED: %s (status %s): %s\n' "$apt_label" "$label" "$status" "$*" >&2
  fi
  return "$status"
}

# The caller supplies the apt argv prefix and phase-specific argument arrays.
apt_fetch() {
  local mirror=$1 update_seconds=$2 download_seconds=$3
  shift 3
  apt_bounded "apt-get update ($mirror)" "$update_seconds" "$@" "${UPDATE_ARGS[@]}" &&
    apt_bounded "apt-get download ($mirror)" "$download_seconds" "${INSTALL_PREFIX[@]}" "$@" "${INSTALL_ARGS[@]}" --download-only "${packages[@]}"
}

# Select from the original sources each time. Leave the successful selection in place for install.
apt_fetch_from_mirror() {
  local source=$1 selected=$2 rewrite=$3 update_seconds=$4 download_seconds=$5 original
  shift 5
  # Test readability before `$(< file)`: Bash 5.2 can exit on a failed redirection before printing our diagnostic.
  if [ ! -r "$source" ] || ! original=$(< "$source"); then
    printf '%s: cannot read apt sources: %s\n' "$apt_label" "$source" >&2
    return 1
  fi
  for apt_mirror in http://azure.archive.ubuntu.com/ubuntu http://archive.ubuntu.com/ubuntu; do
    "$rewrite" "$original" "$selected" "$apt_mirror" "$source" || return "$?"
    printf '%s: using %s\n' "$apt_label" "$apt_mirror"
    if apt_fetch "$apt_mirror" "$update_seconds" "$download_seconds" "$@"; then
      return 0
    fi
    printf '%s: %s failed\n' "$apt_label" "$apt_mirror" >&2
    if [ "$apt_mirror" = http://azure.archive.ubuntu.com/ubuntu ]; then
      printf '%s: trying the next mirror\n' "$apt_label" >&2
    fi
  done
  printf '%s: every mirror failed\n' "$apt_label" >&2
  return 1
}
