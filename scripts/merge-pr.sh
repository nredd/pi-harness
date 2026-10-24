#!/usr/bin/env bash
# Usage: merge-pr.sh <pr> <full-sha> <standards-task-id> <spec-task-id> [history-file] [repo]
# Quotes each reviewer transcript's actual model, verdict and reads in a receipt comment, then merges
# at the reviewed head once CI is green. Reviews are ours, not a CI gate: no commit statuses are posted.
set -euo pipefail
pr=$1 sha=$2 std=$3 spec=$4 history=${5:-} repo=${6:-nredd/pi-harness}
# Transcripts live under the session that spawned the reviewer; resolve each id across sessions.
root=/var/folders/m4/f_bq44js32d_m4smwfhfzp6r0000gn/T/pi-subagents-501/Users-redd
summarize() {
  # Print "<provider/model[, ...]>\t<verdict, first paragraph>\t<what it read>" for one transcript.
  python3 - "$1" <<'EOF'
import json, os, sys
models, final, reads = [], "", []
home = os.path.expanduser("~")
for line in open(sys.argv[1]):
    m = json.loads(line).get("message", {})
    if m.get("role") != "assistant":
        continue
    name = f"{m.get('provider')}/{m.get('model')}"
    if name not in models:
        models.append(name)
    for c in m.get("content", []):
        if c.get("type") == "toolCall":
            a = c.get("arguments") or {}
            target = a.get("base") or a.get("ref") or a.get("rev") or a.get("path") or ""
            target = target.replace(home, "~").split("/code/", 1)[-1]
            if a.get("pattern"):
                target += f" /{a['pattern'][:40]}/"
            entry = f"`{c.get('name')} {target}`"
            if entry not in reads:
                reads.append(entry)
    text = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text").strip()
    final = text or final
if "Findings:" in final:
    checked = sum(1 for l in final.split("Findings:")[0].splitlines() if l.lstrip().startswith("- "))
    verdict = f"{checked} items checked; " + " ".join(final.split("Findings:", 1)[1].split())
else:
    verdict = final.split("\n\n")[0].replace("\n", " ")
print(", ".join(models) + "\t" + verdict + "\t" + ", ".join(reads))
EOF
}
receipt_line() {
  # Validate one transcript and print its receipt suffix: model(s), short id, verdict.
  local t=$1 out models verdict
  out=$(ls "$root"/*/tasks/"$t".output 2>/dev/null) || true
  [[ -n "$out" && $(wc -l <<<"$out") -eq 1 ]] || { echo "transcript $t: expected one file, got: ${out:-none}" >&2; return 1; }
  # A reviewer that could not resolve the reviewed commit must not count as clean. Only git tool
  # results count: a reviewer reading this script (or any file quoting these phrases) is not a failure.
  if python3 - "$out" <<'EOF'
import json, re, sys
bad = re.compile(r"bad revision|unknown revision|ambiguous argument|Not a valid object")
for line in open(sys.argv[1]):
    m = json.loads(line).get("message", {})
    if m.get("role") == "toolResult" and str(m.get("toolName", "")).startswith("git_"):
        if bad.search("".join(c.get("text", "") for c in m.get("content", []))):
            sys.exit(0)
sys.exit(1)
EOF
  then
    echo "transcript $t hit an unresolved revision; fetch the head and re-review" >&2; return 1
  fi
  IFS=$'\t' read -r models verdict reads < <(summarize "$out")
  [[ -n "$models" && -n "$verdict" && -n "$reads" ]] || { echo "transcript $t: no model, verdict or reads" >&2; return 1; }
  echo "\`$models\`, transcript \`${t:0:8}\`): $verdict Read: $reads"
}
std_line=$(receipt_line "$std")
spec_line=$(receipt_line "$spec")
head=$(gh pr view "$pr" --repo "$repo" --json headRefOid -q .headRefOid)
[[ "$head" == "$sha" ]] || { echo "PR head $head != reviewed $sha" >&2; exit 1; }
# CI is the gate: every check on the head must have passed (pending or failing refuses).
# SKIPPED is a job whose `if:` was false (e.g. a tag-only release job on a PR), not a failure.
# dotfiles has no CI; there the local `node --test` result in the history file is the gate.
if [[ "$repo" == nredd/pi-harness ]]; then
  python3 "$(dirname "$0")/merge_pr_checks.py" "$pr" "$sha" "$repo"
elif ! notpass=$(gh pr checks "$pr" --repo "$repo" --json name,state -q '.[] | select(.state != "SUCCESS" and .state != "SKIPPED") | "\(.state) \(.name)"' 2>&1); then
  [[ "$repo" != nredd/pi-harness && "$notpass" == *"no checks reported"* ]] || { echo "$notpass" >&2; exit 1; }
  notpass=
fi
[[ "$repo" == nredd/pi-harness ]] && notpass=
[[ -z "$notpass" ]] || { echo "CI not green on $sha:" >&2; echo "$notpass" >&2; exit 1; }
body=$(mktemp)
{
  echo "Review receipt, final HEAD \`$sha\`:"
  echo
  echo "- Standards (\`code-reviewer\`, $std_line"
  echo "- Spec (\`code-reviewer\`, $spec_line"
  [[ -n "$history" ]] && { echo; cat "$history"; }
} >"$body"
cat "$body"
gh pr comment "$pr" --repo "$repo" --body-file "$body"
gh pr merge "$pr" --repo "$repo" --merge --match-head-commit "$sha"
gh pr view "$pr" --repo "$repo" --json state -q .state
