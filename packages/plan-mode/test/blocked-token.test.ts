import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { blockedShellCallReason } from "../src/child-policy.js";
import { explainBlockedCommand, findBlockedCommandSegment, isSafeCommand } from "../src/tool-policy.js";

// Commands are policy inputs only; nothing in these tables is executed.
const options = { workingDirectory: "/work/repo", homeDir: "/home/user", platform: "linux" as const };
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
  "npm run build",
  "tsc --noEmit --incremental",
  "node script.js",
  "git status --help",
  "git -C . -C /etc status",
  "git -C /etc -C . status",
  "git -C /etc push",
  "git -C . push",
  "git",
  "tsc",
  "sed",
  "git remote show --",
  "npm run",
  "npm --silent run test",
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
  // An interpreter segment that does not tokenize (trailing backslash): `main` rejected, so must we.
  ["ls | python3 \\ ; ls", "python3 \\", /interpreter/],
  ["cat f | sh \\ | cat", "sh \\", /interpreter/],
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
  ["git push origin main", "git push", /reviewed read-only allowlist/],
  ["npm install left-pad", "npm install", /reviewed read-only allowlist/],
  ["sort -o out in", "-o", /argument/],
  ["sed -i s/a/b/ f", "-i", /argument/],
  ["git branch -D x", "-D", /reviewed `git branch` validator/],
  ["git -C /etc status", "/etc", /`-C` directory/],
  ["sed s/a/b/ f", "s/a/b/", /reviewed `sed` validator/],
  ["tsc --noEmit --incremental", "--incremental", /reviewed `tsc` validator/],
  ["npm run build", "build", /reviewed `npm run` validator/],
  ["git -C . -C /etc status", "/etc", /`-C` directory/],
  ["git -C /etc -C . status", "/etc", /`-C` directory/],
  ["git -C /etc push", "/etc", /`-C` directory/],
  ["git -C . push", "git push", /reviewed read-only allowlist/],
  ["git", "git", /no subcommand/],
  ["tsc", "tsc", /reviewed `tsc` validator/],
  ["sed", "sed", /reviewed `sed` validator/],
  ["git remote show --", "git remote", /reviewed `git remote` validator/],
  ["npm run", "run", /reviewed `npm run` validator/],
  ["npm --silent run test", "--silent", /reviewed `npm run` validator/],
  ["hostname foo", "foo", /reviewed `hostname` validator/],
  ["tasklist", "tasklist", /only allowed on Windows/],
  ["frobnicate x", "frobnicate", /reviewed read-only allowlist/],
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
    "npm run build",
    "tsc --noEmit --incremental",
    "node script.js",
    "git status --help",
    "git -C . -C /etc status",
    "git -C /etc -C . status",
    "git -C /etc push",
    "git",
  ]) {
    const blocked = explainBlockedCommand(command, {}, { ...options, platform: "linux" });
    assert.ok(blocked, command);
    assert.doesNotMatch(blocked.reason, /safeSubcommands|allowlist/, command);
  }
});

// Segments whose command/subcommand is already reviewed: a `safeSubcommands` hint would be wrong.
const REVIEWED =
  /^(git (?:-C \S+ |--no-pager )*(?:status|log|diff|show|branch|remote|ls-files|grep)|npm (?:audit|run)|tsc|node|python3?|biome|ruff|ty|sed|hostname|tasklist)\b/;

test("no rejected table input suggests an opt-in for an already-reviewed command", () => {
  for (const [command] of REJECTED) {
    const blocked = explainBlockedCommand(command, safeSubcommands, { ...options, platform: "linux" });
    assert.ok(blocked, command);
    if (/safeSubcommands/.test(blocked.reason)) {
      assert.doesNotMatch(blocked.segment, REVIEWED, `${command}: ${blocked.reason}`);
    }
  }
});

// Fixture provenance: `isSafeCommand(input, { ssh: ["prod"] }, options)` evaluated by the unmodified
// `src/tool-policy.ts` from `origin/main` (06ceb029), copied to a scratch module for the run. The 74
// earlier values reproduced unchanged; the two trailing-backslash interpreter inputs were appended.
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

// Explainer branches the REJECTED table does not reach: [command, safeSubcommands, platform, token, reason].
const MORE_EXPLANATIONS: [string, Record<string, string[]>, NodeJS.Platform, string, RegExp][] = [
  ["''", {}, "linux", "''", /unparseable/],
  ["uniq a b", {}, "linux", "uniq", /arguments not allowed/],
  ["ssh prod ls $HOME", safeSubcommands, "linux", "$HOME", /expansion/],
  ["tasklist /x", {}, "win32", "/x", /reviewed `tasklist` validator/],
  [
    "git --no-pager cat-file --textconv x",
    { git: ["cat-file"] },
    "linux",
    "--textconv",
    /reviewed `git cat-file` validator/,
  ],
];

test.each(MORE_EXPLANATIONS)("explains %j", (command, safe, platform, token, reason) => {
  const blocked = explainBlockedCommand(command, safe, { ...options, platform });
  assert.ok(blocked);
  assert.equal(blocked.token, token);
  assert.match(blocked.reason, reason);
  assert.equal(isSafeCommand(command, safe, { ...options, platform }), false);
});

// Adversarial shapes for the explainer: it must answer (never throw) for anything the decision rejects.
const ADVERSARIAL = [
  "",
  " ",
  "\\",
  "ls \\",
  "ls | python3 \\",
  "ls | sh '\\",
  "ls | python3 'unterminated",
  'ls | sh "unterminated',
  "ls |  | sh",
  "ls ||| sh",
  ";;;",
  "| sh",
  "ls | \\ | sh \\",
  "cd",
  "cd \\",
  "cd 'x",
  "cd a b | ls",
  "cd /etc | sh \\",
  "ssh prod",
  "ssh prod \\",
  "ssh prod 'x",
  "ssh prod ls | sh \\",
  "ssh prod rm \\",
  "ssh prod -o x ls",
  "git -C",
  "git -C \\",
  "git --no-pager",
  "git branch \\",
  "npm run \\",
  "npm \\",
  "sed \\",
  "hostname \\",
  "python3 \\",
  "echo \u00e9\u4e2d\u6587\ud83e\udd69 | sh \\",
  "ls \u0000 | sh",
  "ls | sh\u0000\\",
  "\u0000",
  "caf\u00e9 \u0000 $(x)",
  "FOO=\\",
  "ls \\\\ | sh",
];

test("the explainer answers and never throws, and never changes the decision", () => {
  const inputs = [...ACCEPTED, ...REJECTED.map(([command]) => command), ...EXTRA_DECISION_INPUTS, ...ADVERSARIAL];
  for (const command of inputs) {
    for (const [platform, safe] of [
      ["linux", safeSubcommands],
      ["win32", {}],
    ] as const) {
      const opts = { ...options, platform };
      const blocked = explainBlockedCommand(command, safe, opts);
      assert.equal(blocked === undefined, isSafeCommand(command, safe, opts), command);
      assert.equal(findBlockedCommandSegment(command, safe, opts), blocked?.segment, command);
      if (blocked) {
        assert.equal(typeof blocked.token, "string", command);
        assert.ok(blocked.reason.length > 0, command);
        assert.equal(typeof blocked.segment, "string", command);
      }
      const message = blockedShellCallReason(
        "bash",
        { command },
        { safeSubcommands: safe, trustedDirectories: [] },
        opts,
      );
      assert.equal(message === undefined, blocked === undefined, command);
    }
  }
});

test("explainBlockedCommand falls back to the process defaults", () => {
  assert.equal(explainBlockedCommand("ls"), undefined);
});

test("a remote command rejected by a validator is named through the ssh prefix", () => {
  const blocked = explainBlockedCommand("ssh prod git branch -D x", safeSubcommands, options);
  assert.equal(blocked?.token, "-D");
  assert.match(blocked?.reason ?? "", /remote command: arguments rejected/);
});

test("opt-in hints only name reviewed entries and warn about the trust override", () => {
  const reason = (command: string) =>
    explainBlockedCommand(command, {}, { ...options, platform: "linux" })?.reason ?? "";
  assert.match(
    reason("gh pr list --json number"),
    /exact entry `pr list` in `safeSubcommands.gh`.*skips all argument checks/,
  );
  assert.doesNotMatch(reason("gh pr list --json number"), /`gh pr`|entry `pr`/);
  assert.match(reason("git ls-tree HEAD"), /exact entry `ls-tree` in `safeSubcommands.git`.*skips all argument checks/);
  for (const command of [
    "gh pr merge 218",
    "gh pr",
    "gh",
    "git push origin main",
    "npm install x",
    "cargo run",
    "make",
  ]) {
    assert.doesNotMatch(reason(command), /safeSubcommands/, command);
    assert.match(reason(command), /reviewed read-only allowlist/, command);
  }
  const remote = explainBlockedCommand("ssh prod git push", safeSubcommands, { ...options, platform: "linux" });
  assert.ok(remote);
  assert.doesNotMatch(remote.reason, /safeSubcommands/);
  assert.match(remote.reason, /^remote command: .*reviewed read-only allowlist/);
});
