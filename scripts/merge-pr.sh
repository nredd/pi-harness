#!/bin/bash
# Compatibility bootstrap only, intentionally unmeasured; policy lives in merge-pr.ts.
set -euo pipefail
node=${MERGE_PR_NODE:?Set MERGE_PR_NODE to the trusted absolute Node executable}
[[ "$node" == /* && -f "$node" && -x "$node" ]] || { echo "Invalid Node executable: $node" >&2; exit 1; }
exec "$node" "${BASH_SOURCE[0]%/*}/merge-pr.ts" "$@"
