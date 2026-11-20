#!/usr/bin/env bash
# Shared Ubuntu mirror selection, apt fetch phases and command deadlines.
# Caller globals: `apt_log` enables logging and `apt_capture` is its scratch file.
# `packages`, `UPDATE_ARGS`, `INSTALL_ARGS` and `INSTALL_PREFIX` are argv arrays.
apt_label=ubuntu-apt
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

apt_rewrite_sources() {
  local original=$1 selected=$2 mirror=$3 source=$4
  # GitHub's Noble image can point both stanzas at its on-disk mirror list.
  local ubuntu_uri='(https?://(azure\.archive|archive|security|us-east-2\.ec2\.archive)\.ubuntu\.com/ubuntu/?|mirror\+file:/etc/apt/apt-mirrors\.txt)'
  if ! printf '%s\n' "$original" | grep -Eq "^URIs:[[:blank:]].*$ubuntu_uri([[:blank:]]|$)"; then
    printf '%s: no supported Ubuntu mirror URI in %s\n' "$apt_label" "$source" >&2
    return 1
  fi
  # A pipeline keeps a failed `> "$selected"` redirection inside a subshell on every bash.
  if ! printf '%s\n' "$original" | sed -E "/^URIs:/ s#${ubuntu_uri}([[:blank:]]|$)#${mirror}/\3#g" > "$selected"; then
    printf '%s: could not write apt sources: %s\n' "$apt_label" "$selected" >&2
    return 1
  fi
}

# Select from the original sources each time. Leave the successful selection in place for install.
apt_fetch_from_mirror() {
  local source=$1 selected=$2 update_seconds=$3 download_seconds=$4 original
  shift 4
  # Test readability before `$(< file)`: Bash 5.2 can exit on a failed redirection before printing our diagnostic.
  if [ ! -r "$source" ] || ! original=$(< "$source"); then
    printf '%s: cannot read apt sources: %s\n' "$apt_label" "$source" >&2
    return 1
  fi
  for apt_mirror in http://azure.archive.ubuntu.com/ubuntu http://archive.ubuntu.com/ubuntu; do
    apt_rewrite_sources "$original" "$selected" "$apt_mirror" "$source" || return "$?"
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
