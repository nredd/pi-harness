#!/usr/bin/env bash
# Failure-only evidence for #781/#737. Never emit resolver configuration, addresses,
# search domains, environment or lookup stdout/stderr. The caller bounds this whole
# process (including artifact writes); each optional lookup has its own shorter bound.
set -uo pipefail
report=${1:-}
if [ -n "$report" ] && ! { : > "$report"; } 2> /dev/null; then
  printf 'wsl2-dns: artifact unavailable\n' >&2
  report=
fi
emit() {
  printf 'wsl2-dns: %s\n' "$1"
  if [ -n "$report" ]; then
    printf 'wsl2-dns: %s\n' "$1" 2> /dev/null >> "$report" || report=
  fi
}
emit 'failure-time guest resolver evidence (no addresses or configuration exported)'
# Only this fixed readable Linux path is inspected, under a bound. Validate the
# resulting enum before publication, even though awk itself emits only these labels.
classification=unavailable
if command -v awk > /dev/null 2>&1 && [ -r /etc/resolv.conf ]; then
  value=$(awk '
    $1 == "nameserver" { seen=1; if ($2 !~ /^127\./ && $2 != "::1") external=1 }
    END { print external ? "nonloopback-present" : seen ? "loopback-only" : "none" }
  ' /etc/resolv.conf 2> /dev/null) || value=unavailable
  case "$value" in loopback-only | nonloopback-present | none) classification=$value ;; esac
fi
emit "configured-resolver=$classification"
for tool in getent resolvectl; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    emit "$tool=unavailable"
    continue
  fi
  for name in azure.archive.ubuntu.com archive.ubuntu.com; do
    status=0
    if [ "$tool" = getent ]; then
      timeout --kill-after=1 1 getent ahostsv4 "$name" > /dev/null 2>&1 || status=$?
    else
      timeout --kill-after=1 1 resolvectl query --legend=no "$name" > /dev/null 2>&1 || status=$?
    fi
    case "$status" in
      0) outcome=resolved ;;
      124 | 137) outcome=timeout ;;
      *) outcome=failed ;;
    esac
    emit "$tool $name=$outcome"
  done
done
emit 'capture complete; lookup outcomes do not establish the historical resolver cause'
