#!/usr/bin/env bash
# Isolation smoke for the self-hosted `pi-wsl2` pool (#736). Runs as the unprivileged runner user inside the job's
# throwaway WSL2 distro, first in every pooled cell and again from `runner-smoke.yml`. Exit status is non-zero on
# any violation: the public internet must answer, private ranges, the Windows host, the owner's dev environment and
# every Windows path or interpreter must not.
#
# Targets that depend on the host are injected by the environment, never written down here:
#   SMOKE_HOST_IP     the Windows host's address as the guest could reach it, if not the default gateway
#   SMOKE_DEV_IP      the dev environment's LAN address, if it has one
#   SMOKE_DEV_PORTS   space-separated ports its services listen on (default: none)
#   SMOKE_ROOT        prefix for the host paths probed below, for tests only (default: empty)
# No token is read, written or echoed.
set -u

root=${SMOKE_ROOT:-}
fail=0
bad() {
  printf '::error::%s\n' "$*"
  fail=1
}
ok() { printf 'ok: %s\n' "$*"; }
# True when a TCP connection opens within 4s.
tcp() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

printf 'runner: %s uid=%s arch=%s kernel=%s\n' "$(id -un)" "$(id -u)" "$(uname -m)" "$(uname -r)"
if [ "$(id -u)" -ne 0 ]; then ok 'non-root'; else bad 'running as root'; fi
if [ "$(uname -m)" = aarch64 ]; then ok 'aarch64'; else bad "not aarch64: $(uname -m)"; fi
if sudo -n true 2>/dev/null; then bad 'sudo works'; else ok 'no sudo'; fi
# Unprivileged user namespaces are a root-in-namespace route to kernel attack surface: they must be off.
limit=$(cat "$root"/proc/sys/user/max_user_namespaces 2>/dev/null || echo unreadable)
if [ "$limit" != 0 ]; then bad "user.max_user_namespaces is $limit, not 0"; else ok 'user.max_user_namespaces is 0'; fi
if ! command -v unshare >/dev/null 2>&1; then
  bad 'unshare is missing, so user namespaces cannot be checked'
elif unshare -Urn true 2>/dev/null; then
  bad 'unprivileged user namespaces are enabled'
else
  ok 'no unprivileged user namespaces'
fi

# Public internet
for url in https://api.github.com https://registry.npmjs.org/; do
  if curl -fsS --max-time 10 -o /dev/null "$url"; then ok "reachable: $url"; else bad "unreachable: $url"; fi
done

# Private classes, CGNAT/tailnet, link-local and the gateway (the Windows host on the NAT switch).
gateway=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
targets=(192.168.1.1:80 10.0.0.1:80 172.16.0.1:80 100.64.0.1:22 100.100.100.100:80 169.254.169.254:80)
if [ -n "${gateway:-}" ]; then targets+=("$gateway:445" "$gateway:135" "$gateway:53"); fi
if [ -n "${SMOKE_HOST_IP:-}" ]; then targets+=("$SMOKE_HOST_IP:445" "$SMOKE_HOST_IP:3389" "$SMOKE_HOST_IP:5985"); fi
dev_ports=${SMOKE_DEV_PORTS:-}
if [ -n "${SMOKE_DEV_IP:-}" ]; then
  for port in $dev_ports; do targets+=("$SMOKE_DEV_IP:$port"); done
fi
# A refused or dropped probe looks the same as a failed one, so prove the probe machinery works first: a public
# TCP connection must open, and `timeout` must exist (a missing one would make every probe look blocked).
if ! command -v timeout >/dev/null 2>&1; then
  bad 'timeout is missing, so no probe can prove anything'
elif tcp api.github.com 443; then
  ok 'public positive control connected'
else
  bad 'probe machinery cannot open a public connection, so the blocked results below prove nothing'
fi
for target in "${targets[@]}"; do
  if tcp "${target%:*}" "${target##*:}"; then bad "reachable: $target"; else ok "blocked: $target"; fi
done
# The dev environment's loopback services live in another VM, so nothing may answer on this one's loopback.
for port in $dev_ports; do
  if tcp 127.0.0.1 "$port"; then bad "loopback:$port answers"; else ok "loopback:$port closed"; fi
done

# Layer 1 rules need CAP_NET_ADMIN to read: the reachability probes above are what prove them as this user.
if [ "$(cat "$root"/proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" = 1 ]; then ok 'ipv6 off'; else bad 'ipv6 on'; fi

# No Windows reach: no automount, no interop, no Windows PATH.
if [ -e "$root/mnt/c" ] || [ -e "$root/mnt/d" ]; then bad '/mnt/c or /mnt/d exists'; else ok 'no /mnt/c'; fi
if [ -e "$root/proc/sys/fs/binfmt_misc/WSLInterop" ] || [ -e "$root/proc/sys/fs/binfmt_misc/WSLInterop-late" ]; then
  bad 'WSLInterop binfmt present'
else
  ok 'no WSLInterop'
fi
if compgen -G "$root/run/WSL/*interop*" >/dev/null; then bad '/run/WSL interop sockets present'; else ok 'no interop sockets'; fi
case ":$PATH:" in *:/mnt/*) bad 'Windows path on PATH' ;; *) ok 'no Windows PATH' ;; esac
for exe in cmd.exe powershell.exe wsl.exe explorer.exe; do
  if command -v "$exe" >/dev/null 2>&1; then bad "can find $exe"; else ok "no $exe"; fi
done
if findmnt -t drvfs,9p,virtiofs 2>/dev/null | grep -q .; then bad 'drvfs/9p mount present'; else ok 'no drvfs/9p mounts'; fi

exit "$fail"
