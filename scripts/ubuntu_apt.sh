#!/usr/bin/env bash
# Shared Ubuntu 24.04 mirror selection and command deadlines. Source from a Bash script using pipefail.

apt_label=ubuntu-apt

apt_bounded() {
  local label=$1 seconds=$2 status=0
  local -a statuses=()
  shift 2
  if [ -n "${apt_log:-}" ]; then
    timeout --kill-after=10 "$seconds" "$@" 2>&1 | tee -a "$apt_log" || statuses=("${PIPESTATUS[@]}")
    status=${statuses[0]:-0}
    if [ "${statuses[1]:-0}" -ne 0 ]; then
      printf '%s: could not append to %s (status %s)\n' "$apt_label" "$apt_log" "${statuses[1]}" >&2
      [ "$status" -ne 0 ] || status=${statuses[1]}
    fi
  else
    timeout --kill-after=10 "$seconds" "$@" || status=$?
  fi
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf '%s: TIMEOUT: %s exceeded %ss: %s\n' "$apt_label" "$label" "$seconds" "$*" >&2
    if [ "$apt_label" = wsl2-apt ]; then
      printf 'wsl2-apt: guest processes, newest first:\n' >&2
      { ps -eo pid,ppid,etime,stat,args --sort=etime | head -n 40 >&2; } || true
    fi
  elif [ "$status" -ne 0 ]; then
    printf '%s: FAILED: %s (status %s): %s\n' "$apt_label" "$label" "$status" "$*" >&2
  fi
  return "$status"
}

# Rewrite both archive and security stanzas from the original Deb822 sources on each attempt.
# The successful source must stay selected for the install to use the matching lists and .debs.
apt_fetch_from_mirror() {
  local source=$1 selected=$2 fetch=$3 original mirror
  # GitHub's Noble image can point both stanzas at its on-disk mirror list.
  local ubuntu_uri='(https?://(azure\.archive|archive|security|us-east-2\.ec2\.archive)\.ubuntu\.com/ubuntu/?|mirror\+file:/etc/apt/apt-mirrors\.txt)'
  if ! original=$(< "$source"); then
    printf '%s: cannot read apt sources: %s\n' "$apt_label" "$source" >&2
    return 1
  fi
  if ! grep -Eq "^URIs:[[:blank:]].*$ubuntu_uri([[:blank:]]|$)" <<< "$original"; then
    printf '%s: no supported Ubuntu mirror URI in %s\n' "$apt_label" "$source" >&2
    return 1
  fi
  for mirror in http://azure.archive.ubuntu.com/ubuntu http://archive.ubuntu.com/ubuntu; do
    if ! sed -E "/^URIs:/ s#${ubuntu_uri}([[:blank:]]|$)#${mirror}/\3#g" <<< "$original" > "$selected"; then
      printf '%s: could not write apt sources: %s\n' "$apt_label" "$selected" >&2
      return 1
    fi
    printf '%s: using %s\n' "$apt_label" "$mirror"
    if "$fetch" "$mirror"; then
      return 0
    fi
    printf '%s: %s failed\n' "$apt_label" "$mirror" >&2
    if [ "$mirror" = http://azure.archive.ubuntu.com/ubuntu ]; then
      printf '%s: trying the next mirror\n' "$apt_label" >&2
    fi
  done
  printf '%s: every mirror failed\n' "$apt_label" >&2
  return 1
}
