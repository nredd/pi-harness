#!/usr/bin/env bash
# Execute the same SHA-pinned install-action manifests as the native owned cell.
# Official contract: install-action/action.yml maps INPUT_* and runs main.sh.
set -euo pipefail
ref=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const source = readFileSync(".github/actions/setup-ci-tools/action.yml", "utf8");
  const refs = [...source.matchAll(/uses: taiki-e\/install-action@([0-9a-f]{40})/g)];
  if (refs.length !== 1) throw new Error("Expected one authoritative install-action SHA");
  console.log(refs[0][1]);
')
tool_dir=${1:?Tool directory required}
mkdir -p "$tool_dir/install-action"
curl --fail --location --retry 3 --output "$tool_dir/install-action.tar.gz" \
  "https://codeload.github.com/taiki-e/install-action/tar.gz/$ref"
tar -xzf "$tool_dir/install-action.tar.gz" --strip-components=1 --directory "$tool_dir/install-action"
paths="$tool_dir/install-action-paths"
: > "$paths"
env -u GH_TOKEN -u GITHUB_TOKEN -u DEFAULT_GITHUB_TOKEN \
  INPUT_TOOL=rust+rustfmt+clippy,cargo-nextest INPUT_CHECKSUM=true INPUT_FALLBACK=none \
  GITHUB_ACTION_PATH="$tool_dir/install-action" GITHUB_PATH="$paths" \
  RUNNER_OS=Linux RUNNER_ARCH=X64 ACTION_USER_AGENT="taiki-e/install-action ($ref)" \
  bash --noprofile --norc "$tool_dir/install-action/main.sh"
while IFS= read -r directory; do
  export PATH="$directory:$PATH"
done < "$paths"
rustc --version
cargo --version
cargo fmt --version
cargo clippy --version
cargo nextest --version
# Caller imports only this explicit PATH receipt, never sources downloaded output.
printf '%s\n' "$PATH" > "$tool_dir/owned-tool-path"
