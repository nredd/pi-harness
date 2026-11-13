import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { blockedShellCallReason } from "../src/child-policy.js";
import { explainBlockedCommand, findBlockedCommandSegment, isSafeCommand } from "../src/tool-policy.js";

// Commands are policy inputs only; nothing in these tables is executed.
const options = { workingDirectory: "/work/repo", homeDir: "/home/user" };
const safeSubcommands = { ssh: ["prod"] };

const ACCEPTED = [
  "wc -l a.ts b.ts",
  "find src -name '*.py' -not -path 'src/gen/*' | sort",
  "git status --short | head -5",
  "ls && cat README.md | head -5",
  "ls; pwd",
  "cat a | grep b | sort | uniq | wc -l",
  "echo 'a; rm b'",
  'echo "x && rm y | sh"',
  "echo a\\;rm",
  "grep 'a|b' file | wc -l",
];

test.each(ACCEPTED)("accepts a compound whose every segment is read-only: %s", (command) => {
  assert.equal(explainBlockedCommand(command, {}, options), undefined);
  assert.equal(isSafeCommand(command, {}, options), true);
});

const EXTRA_DECISION_INPUTS = [
  "git remote add x y",
  "git log --output=f",
  "npm audit fix",
  "git status",
  "git branch",
  "git -C /work/repo status",
  "sed -n 1,5p f",
  "hostname",
];

const REJECTED: [string, string, RegExp][] = [
  ["cat x | sh", "sh", /interpreter/],
  ["cat x | bash -c 'rm y'", "bash", /interpreter/],
  ["cat x | xargs rm", "xargs", /interpreter/],
  ["ls; rm -rf x", "rm", /mutat/],
  ["ls && rm x && ls", "rm", /mutat/],
  ["ls || touch x", "touch", /mutat/],
  ["echo $(rm x)", "$(", /substitution/],
  ['echo "$(rm x)"', "$(", /substitution/],
  ["echo `rm x`", "`", /substitution/],
  ["diff <(ls) <(ls)", "<(", /substitution/],
  ["cat > f", ">", /redirect/],
  ["cat >> f", ">>", /redirect/],
  ["cat x 2> f", ">", /redirect/],
  ["wc -l < f", "<", /redirect/],
  ["cat <<EOF", "<<", /redirect/],
  ["(ls)", "(", /subshell|grouping/],
  ["ls &", "&", /background/],
  ["ls & rm x", "&", /background/],
  ["FOO=1 ls", "FOO=1", /assignment/],
  ["ls; FOO=1 ls", "FOO=1", /assignment/],
  ["wc -l src/*.ts", "src/*.ts", /expansion|glob/],
  ["ls $HOME", "$HOME", /expansion/],
  ["find . -name x -delete", "-delete", /argument/],
  ["find . -execdir ls x +", "-execdir", /argument/],
  ["find . -exec rm {} +", "{}", /expansion/],
  ["git push origin main", "git push", /allowlist/],
  ["npm install left-pad", "npm install", /allowlist/],
  ["sort -o out in", "-o", /argument/],
  ["sed -i s/a/b/ f", "-i", /argument/],
  ["git branch -D x", "-D", /reviewed `git branch` validator/],
  ["git -C /etc status", "/etc", /reviewed `git`/],
  ["sed s/a/b/ f", "s/a/b/", /reviewed `sed` validator/],
  ["hostname foo", "foo", /reviewed `hostname` validator/],
  ["tasklist", "tasklist", /only allowed on Windows/],
  ["frobnicate x", "frobnicate", /allowlist/],
  ["ls &&", "&&", /no command|empty/],
  ["; ls", ";", /no command|empty/],
  ["ls |", "|", /no command|empty/],
  ["echo 'oops", "'", /quote/],
  ["cd /etc && ls", "/etc", /directory/],
  ["ssh other uptime", "ssh", /prefix/],
  ["ssh prod uptime; rm x", "rm", /mutat/],
];

test.each(REJECTED)("rejects %j and names `%s`", (command, token, reason) => {
  const blocked = explainBlockedCommand(command, safeSubcommands, options);
  assert.ok(blocked, `expected ${command} to be blocked`);
  assert.equal(blocked.token, token);
  assert.match(blocked.reason, reason);
  assert.equal(isSafeCommand(command, safeSubcommands, options), false);
  assert.equal(findBlockedCommandSegment(command, safeSubcommands, options), blocked.segment);
});

test("does not loosen the literal ssh prefix match", () => {
  assert.equal(explainBlockedCommand("ssh prod uptime", safeSubcommands, options), undefined);
  assert.equal(explainBlockedCommand("ssh prod uptime | wc -l", safeSubcommands, options), undefined);
  assert.ok(explainBlockedCommand("ssh -o ConnectTimeout=8 prod uptime", safeSubcommands, options));
  assert.ok(explainBlockedCommand("ssh user@prod uptime", safeSubcommands, options));
  assert.ok(explainBlockedCommand("ssh prod uptime > f", safeSubcommands, options));
});

test("the rejection message names the offending token and why", () => {
  const reason = blockedShellCallReason(
    "bash",
    { command: "ls; rm -rf x" },
    { safeSubcommands: {}, trustedDirectories: [] },
    options,
  );
  assert.equal(
    reason,
    "Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: rm -rf x\nOffending token: rm (mutating command)",
  );
  assert.equal(
    blockedShellCallReason("bash", { command: "cat x > f" }, { safeSubcommands: {}, trustedDirectories: [] }, options),
    "Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: cat x > f\nOffending token: > (redirection)",
  );
});

test("an explanation never offers `safeSubcommands` for a command that is already reviewed", () => {
  for (const command of [
    "git branch -D x",
    "git -C /etc status",
    "sed s/a/b/ f",
    "hostname foo",
    "tasklist",
    "git remote add x y",
    "git log --output=f",
    "npm audit fix",
  ]) {
    const blocked = explainBlockedCommand(command, {}, { ...options, platform: "linux" });
    assert.ok(blocked, command);
    assert.doesNotMatch(blocked.reason, /safeSubcommands|allowlist/, command);
  }
});

// Segments whose command/subcommand is already reviewed: a `safeSubcommands` hint would be wrong.
const REVIEWED = /^(git (status|log|diff|show|branch|remote|ls-files|grep)|sed|hostname|tasklist)\b/;

test("no rejected table input suggests an opt-in for an already-reviewed command", () => {
  for (const [command] of REJECTED) {
    const blocked = explainBlockedCommand(command, safeSubcommands, { ...options, platform: "linux" });
    assert.ok(blocked, command);
    if (/safeSubcommands/.test(blocked.reason)) {
      assert.doesNotMatch(blocked.token, REVIEWED, `${command}: ${blocked.reason}`);
    }
  }
});

test("accept/reject decisions match main for every table input", () => {
  const expected = JSON.parse(
    readFileSync(new URL("fixtures/blocked-token-main-decisions.json", import.meta.url), "utf8"),
  );
  const inputs = [...ACCEPTED, ...REJECTED.map(([command]) => command), ...EXTRA_DECISION_INPUTS];
  assert.deepEqual(Object.keys(expected).sort(), [...new Set(inputs)].sort());
  for (const command of inputs) {
    assert.equal(
      isSafeCommand(command, safeSubcommands, { ...options, platform: "linux" }),
      expected[command],
      command,
    );
  }
});
