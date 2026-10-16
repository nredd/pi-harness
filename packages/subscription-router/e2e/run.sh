#!/usr/bin/env bash
# Run the faux e2e against the installed `pi` in a throwaway agent dir, and assert the outcome.
# Usage: e2e/run.sh [all|terminal|retry|unconfirmed|wait|fail|capped|no-router|balanced-*]
#
# terminal|retry|unconfirmed: mid-run recovery and routing (router only).
# wait|fail|capped|no-router: pi-subagents dispatch admission and the exhaustion policy
# (router + pi-subagents; `no-router` is the enterprise profile, subagents alone).
# balanced-route|switch|sticky|blocked|fallback|unmeasured: installed Pi RPC, three faux providers.
# pi-subagents comes from $PI_SUBAGENTS_DIR (default ~/code/pi-subagents).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
subagents="${PI_SUBAGENTS_DIR:-$HOME/code/pi-subagents}"
scenario="${1:-all}"

if [[ "$scenario" == all ]]; then
  status=0
  for each in terminal retry unconfirmed wait fail capped no-router balanced-route balanced-switch balanced-sticky balanced-blocked balanced-fallback balanced-unmeasured; do
    echo "=== $each"
    "$0" "$each" || status=1
  done
  exit "$status"
fi

agent="$(mktemp -d)"
trap 'rm -rf "$agent"' EXIT
profile() { # $1 = extra profile fields, with a leading comma
  echo "{ \"profiles\": { \"spike\": { \"chain\": [{ \"model\": \"spike-a/sonnet-a\" }, { \"model\": \"spike-b/terra-b\" }]$1 } } }"
}
extensions=(-e "$here/e2e/faux-quota.ext.ts" -e "$here/src/index.ts")
model=router/spike
expect=() # grep -E patterns that must match
reject=() # grep -E patterns that must not match
case "$scenario" in
  balanced-route|balanced-switch|balanced-sticky|balanced-blocked|balanced-fallback|balanced-unmeasured)
    printf '%s\n' '{ "profiles": { "spike": { "strategy": "balanced", "chain": [{ "model": "spike-a/sonnet-a" }, { "model": "spike-b/terra-b" }, { "model": "spike-c/third-c" }] } } }' >"$agent/subscription-router.json"
    cd "$agent"
    PI_CODING_AGENT_DIR="$agent" node "$here/e2e/balanced-rpc.mjs" "$here" "$scenario"
    exit $? ;;
  terminal)
    export SPIKE_ERROR="insufficient_quota: You exceeded your current quota"
    profile "" >"$agent/subscription-router.json"
    expect=("RECOVERED on spike-b/terra-b") ;;
  retry)
    export SPIKE_ERROR="429 Too Many Requests: rate_limit_error"
    profile "" >"$agent/subscription-router.json"
    expect=("auto_retry_start" "RECOVERED on spike-b/terra-b") ;;
  unconfirmed)
    export SPIKE_ERROR="insufficient_quota: You exceeded your current quota" SPIKE_CONFIRM=unconfirmed
    profile "" >"$agent/subscription-router.json"
    expect=("confirmed=false") reject=("RECOVERED") ;;
  wait|fail|capped|no-router)
    [[ -d "$subagents" ]] || { echo "pi-subagents not found at $subagents (set PI_SUBAGENTS_DIR)" >&2; exit 2; }
    export SPIKE_BLOCKED=1
    model=spike-main/driver
    extensions=(-e "$here/e2e/faux-admission.ext.ts" -e "$subagents/src/index.ts" -e "$here/src/index.ts")
    case "$scenario" in
      wait) profile ', "exhaustionPolicy": "wait"' >"$agent/subscription-router.json"
        expect=("Queued" "DRIVER DONE") reject=("was not started") ;;
      fail) profile ', "exhaustionPolicy": "fail"' >"$agent/subscription-router.json"
        expect=("was not started" "DRIVER DONE") reject=("Queued") ;;
      capped) profile ', "maxWaitMinutes": 30' >"$agent/subscription-router.json"
        expect=("was not started" "DRIVER DONE") reject=("Queued") ;;
      no-router)
        # Enterprise: no router loaded, so the Agent call is admitted and the child runs on a physical model.
        export SPIKE_AGENT_MODEL=spike-b/terra-b SPIKE_BACKGROUND=0 SPIKE_BLOCKED=0
        extensions=(-e "$here/e2e/faux-admission.ext.ts" -e "$subagents/src/index.ts")
        expect=("ANSWERED on spike-b" "DRIVER DONE") reject=("was not started" "Queued") ;;
    esac ;;
  *) echo "unknown scenario: $scenario" >&2; exit 2 ;;
esac

cd "$agent"
out="$(PI_CODING_AGENT_DIR="$agent" pi --no-extensions --no-session "${extensions[@]}" \
  --model "$model" --mode json -p "run the tool" 2>&1 \
  | jq -Rrc 'fromjson? // . | if type=="string" then . else
      select(.type=="message_end" or .type=="auto_retry_start" or .type=="agent_end")
      | if .type=="message_end" then [.type, .message.role, (.message.provider // ""), (.message.model // ""), (.message.stopReason // ""), ((.message.errorMessage // "")|.[0:80]), ((.message.content|if type=="array" then (map(.text? // .name? // "")|join("|")) else . end)|tostring|.[0:160])]
        else [.type, (.errorMessage // "")] end end')"
echo "$out"

fail=0
for pattern in "${expect[@]}"; do
  grep -Eq -- "$pattern" <<<"$out" || { echo "FAIL $scenario: expected /$pattern/" >&2; fail=1; }
done
for pattern in ${reject[@]+"${reject[@]}"}; do
  if grep -Eq -- "$pattern" <<<"$out"; then echo "FAIL $scenario: unexpected /$pattern/" >&2; fail=1; fi
done
[[ $fail -eq 0 ]] && echo "PASS $scenario"
exit "$fail"
