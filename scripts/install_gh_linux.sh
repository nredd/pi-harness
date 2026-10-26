#!/usr/bin/env bash
# Install the pinned official GitHub CLI into a directory, for runners whose package manager
# ships a `gh` without `attestation` (Ubuntu 24.04 apt has 2.45; `gh attestation verify` needs 2.49+).
#
# Usage: install_gh_linux.sh <install-dir>   # then put <install-dir>/bin on PATH
#
# The tarball and its sha256 are from the immutable cli/cli release; the digest was checked against
# `gh release verify-asset v2.103.2 gh_2.103.2_linux_amd64.tar.gz --repo cli/cli`. To bump, repeat that
# on the new release and change BOTH values below. No token is read, written or echoed.
set -euo pipefail

GH_VERSION=2.103.2
GH_SHA256=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <install-dir>" >&2
  exit 2
fi
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "install_gh_linux.sh supports only linux/x86_64, got $(uname -s)/$(uname -m)" >&2
  exit 1
fi

install_dir=$1
archive="gh_${GH_VERSION}_linux_amd64.tar.gz"
mkdir -p "$install_dir"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

curl --fail --location --silent --show-error --retry 3 --output "$scratch/$archive" \
  "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}"
printf '%s  %s\n' "$GH_SHA256" "$scratch/$archive" | sha256sum --check --status || {
  echo "gh ${GH_VERSION} sha256 mismatch for ${archive}; refusing to install" >&2
  exit 1
}
tar --extract --gzip --file "$scratch/$archive" --directory "$install_dir" --strip-components=1
test "$("$install_dir/bin/gh" --version | head -n1 | cut -d' ' -f3)" = "$GH_VERSION"
"$install_dir/bin/gh" attestation verify --help >/dev/null
echo "Installed gh ${GH_VERSION} at ${install_dir}/bin/gh"
