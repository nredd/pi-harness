#!/usr/bin/env bash
# Fetch then install the upstream core CI prerequisites on a disposable Ubuntu 24.04 runner.
set -euo pipefail

# shellcheck source=scripts/ubuntu_apt.sh
source "$(dirname "${BASH_SOURCE[0]}")/ubuntu_apt.sh"
apt_label=forks-apt
sources=$1
apt_log=$2
update_seconds=$3
download_seconds=$4
install_seconds=$5
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
selected="$scratch/ubuntu.sources"
apt_capture="$scratch/apt-output"
packages=(libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep)
apt=(apt-get
  -o "Dir::Etc::sourcelist=$selected" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
  -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10
  -o Acquire::Languages=none -o DPkg::Lock::Timeout=10 -o Dpkg::Use-Pty=0)

UPDATE_ARGS=(update --error-on=any)
INSTALL_ARGS=(install --yes)
INSTALL_PREFIX=(env DEBIAN_FRONTEND=noninteractive)

apt_fetch_from_mirror "$sources" "$selected" "$update_seconds" "$download_seconds" "${apt[@]}"
# Do not retry dpkg failures on another mirror. Everything needed is already in the archives.
apt_bounded "apt-get install ($apt_mirror)" "$install_seconds" "${INSTALL_PREFIX[@]}" "${apt[@]}" "${INSTALL_ARGS[@]}" --no-download "${packages[@]}"
