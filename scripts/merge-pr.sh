#!/bin/bash
# Usage: merge-pr.sh <pr> <full-sha> <standards-task-id> <spec-task-id> [history-file] [repo]
# Quotes each reviewer transcript's actual model, verdict and reads in a receipt comment, then merges
# at the reviewed head once CI is green. Reviews are ours, not a CI gate: no commit statuses are posted.
set -euo pipefail
pr=$1 sha=$2 std=$3 spec=$4 history=${5:-} repo=${6:-nredd/pi-harness}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected full reviewed HEAD SHA" >&2; exit 1; }
[[ "$std" != "$spec" ]] || { echo "Standards and Spec require distinct transcript IDs" >&2; exit 1; }
[[ "$std" =~ ^[[:alnum:]-]+$ && "$spec" =~ ^[[:alnum:]-]+$ ]] || { echo "Invalid transcript ID" >&2; exit 1; }
# Inputs are explicit: never discover authenticated executables through PATH or embed workstation state.
root=${MERGE_PR_TRANSCRIPT_ROOT:?Set MERGE_PR_TRANSCRIPT_ROOT to the absolute transcript storage directory}
gh=${MERGE_PR_GH:?Set MERGE_PR_GH to the trusted absolute gh executable}
python=${MERGE_PR_PYTHON:?Set MERGE_PR_PYTHON to the trusted absolute Python environment executable}
[[ "$root" == /* && -d "$root" ]] || { echo "Invalid transcript root: $root" >&2; exit 1; }
[[ "$gh" == /* && -f "$gh" && -x "$gh" ]] || { echo "Invalid gh executable: $gh" >&2; exit 1; }
[[ "$python" == /* && -f "$python" && -x "$python" ]] || { echo "Invalid Python executable: $python" >&2; exit 1; }
summarize() {
  # Print "<provider/model[, ...]>\t<verdict, first paragraph>\t<what it read>" for one transcript.
  "$python" - "$1" "$sha" "$2" <<'EOF'
import json, re, sys
from pathlib import Path
models, final, reads = [], "", []
home = str(Path.home().resolve())
transcript = Path(sys.argv[1]).resolve()
if not transcript.is_file():
    sys.exit(f"Transcript is not a file: '{transcript}'")
for line in transcript.read_text(encoding="utf-8").splitlines():
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
# Bind the final report, not an earlier request/tool argument or an incidental SHA mention.
header = re.match(r"\AAxis: (Standards|Spec)\nReviewed HEAD: ([0-9a-f]{40})\n", final)
if (not header or header.groups() != (sys.argv[3], sys.argv[2])
        or len(re.findall(r"^Axis:", final, re.M)) != 1
        or len(re.findall(r"^Reviewed HEAD:", final, re.M)) != 1
        or not re.search(r"^Checked:\n- .+", final, re.M)
        or not re.search(r"^Findings:\n.+", final, re.M)):
    sys.exit(f"transcript: final report must declare Axis: {sys.argv[3]} and Reviewed HEAD: {sys.argv[2]}")
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
  local t=$1 axis=$2 out models verdict
  out=$(/bin/ls -d "$root"/*/tasks/"$t".output 2>/dev/null) || true
  [[ -n "$out" && $(/usr/bin/wc -l <<<"$out") -eq 1 ]] || { echo "transcript $t: expected one file, got: ${out:-none}" >&2; return 1; }
  # Check failed Git results, not diagnostics quoted by successful source reads/diffs.
  # Missing/malformed result metadata and reader errors fail closed; later success cannot erase failure.
  if ! "$python" - "$out" <<'EOF'
import json, re, sys
from pathlib import Path
bad = re.compile(r"bad revision|unknown revision|ambiguous argument|Not a valid object")
transcript = Path(sys.argv[1]).resolve()
if not transcript.is_file():
    sys.exit(f"Transcript is not a file: '{transcript}'")
for line in transcript.read_text(encoding="utf-8").splitlines():
    m = json.loads(line).get("message", {})
    if m.get("role") == "toolResult" and str(m.get("toolName", "")).startswith("git_"):
        content = m.get("content")
        if type(m.get("isError")) is not bool or not isinstance(content, list):
            sys.exit("Git result lacks boolean isError or content metadata")
        if any(not isinstance(c, dict) or c.get("type") != "text"
               or not isinstance(c.get("text"), str) for c in content):
            sys.exit("Git result contains malformed text content")
        text = "".join(c["text"] for c in content)
        if m["isError"] and (not text.strip() or bad.search(text)):
            sys.exit("Failed Git result has an unresolved revision or missing diagnostic")
sys.exit(0)
EOF
  then
    echo "transcript $t: failed or unverifiable Git evidence; fetch the head and re-review" >&2; return 1
  fi
  IFS=$'\t' read -r models verdict reads < <(summarize "$out" "$axis")
  [[ -n "$models" && -n "$verdict" && -n "$reads" ]] || { echo "transcript $t: no model, verdict or reads" >&2; return 1; }
  echo "\`$models\`, transcript \`${t:0:8}\`): $verdict Read: $reads"
}
std_line=$(receipt_line "$std" Standards)
spec_line=$(receipt_line "$spec" Spec)
head=$("$gh" pr view "$pr" --repo "$repo" --json headRefOid -q .headRefOid)
[[ "$head" == "$sha" ]] || { echo "PR head $head != reviewed $sha" >&2; exit 1; }
# CI is the gate: every check on the head must have passed (pending or failing refuses).
# SKIPPED is a job whose `if:` was false (e.g. a tag-only release job on a PR), not a failure.
# dotfiles has no CI; there the local `node --test` result in the history file is the gate.
if [[ "$repo" == nredd/pi-harness ]]; then
  "$python" "$(/usr/bin/dirname "$0")/merge_pr_checks.py" "$pr" "$sha" "$repo"
elif ! notpass=$("$gh" pr checks "$pr" --repo "$repo" --json name,state -q '.[] | select(.state != "SUCCESS" and .state != "SKIPPED") | "\(.state) \(.name)"' 2>&1); then
  [[ "$repo" != nredd/pi-harness && "$notpass" == *"no checks reported"* ]] || { echo "$notpass" >&2; exit 1; }
  notpass=
fi
[[ "$repo" == nredd/pi-harness ]] && notpass=
[[ -z "$notpass" ]] || { echo "CI not green on $sha:" >&2; echo "$notpass" >&2; exit 1; }
body=$(/usr/bin/mktemp)
{
  echo "Review receipt, final HEAD \`$sha\`:"
  echo
  echo "- Standards (\`code-reviewer\`, $std_line"
  echo "- Spec (\`code-reviewer\`, $spec_line"
  [[ -n "$history" ]] && { echo; /bin/cat "$history"; }
} >"$body"
/bin/cat "$body"
"$gh" pr comment "$pr" --repo "$repo" --body-file "$body"
"$gh" pr merge "$pr" --repo "$repo" --merge --match-head-commit "$sha"
"$gh" pr view "$pr" --repo "$repo" --json state -q .state
