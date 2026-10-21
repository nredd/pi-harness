import assert from "node:assert/strict";
import { test } from "vitest";
import {
  findBlockedCommandSegment,
  findBlockedPowerShellCommandSegment,
  isSafeCommand,
  isSafePowerShellCommand,
} from "../src/tool-policy.js";

const safeSubcommands = {
  go: ["version", "list"],
  gofmt: ["-l", "-d"],
  git: ["rev-parse"],
  cargo: ["metadata", "tree"],
  kubectl: ["apply"],
  "Invoke-Trusted": ["run"],
};

// Commands are policy inputs only; no shell commands in these tables are executed.
test.each([
  ["go version && chmod 000 /tmp/nonexistent-probe", "chmod 000 /tmp/nonexistent-probe"],
  ["git rev-parse HEAD && rm -rf /tmp/nonexistent-probe", "rm -rf /tmp/nonexistent-probe"],
  ["go list ./... ; touch /tmp/nonexistent-probe", "touch /tmp/nonexistent-probe"],
  ["gofmt -l server && git push origin main", "git push origin main"],
  ["go version && ls > /tmp/out", "go version && ls > /tmp/out"],
  ["cargo metadata && npm install left-pad", "npm install left-pad"],
])("issue 1457 rejects the untrusted operation: %s", (command, blocked) => {
  assert.equal(findBlockedCommandSegment(command, safeSubcommands), blocked);
  assert.equal(isSafeCommand(command, safeSubcommands), false);
  assert.equal(isSafeCommand(command), false, "the default policy must remain restrictive");
});

test.each(["&&", "||", ";", "|"])("Bash evaluates all segments separated by %s", (separator) => {
  for (const command of [
    `go version ${separator} touch output`,
    `touch output ${separator} go version`,
    `git status ${separator} go version ${separator} touch output`,
    `go version ${separator} touch output ${separator} go list ./...`,
  ]) {
    assert.equal(findBlockedCommandSegment(command, safeSubcommands), "touch output", command);
  }
  assert.equal(isSafeCommand(`go version ${separator} git status ${separator} go list ./...`, safeSubcommands), true);
});

test.each([
  "go version",
  "git rev-parse --abbrev-ref HEAD",
  "gofmt -l server pkg",
  "gofmt -d server/scheduler/scheduler.go",
  "cargo metadata --no-deps",
  "cargo tree -p example",
  "go test ./...",
  "cat AGENTS.md",
  'grep -rn "Outbox" server --include="*.go"',
  'rg -n "current_session_id" server',
  'find . -name "*.rs" | head -20',
  'git ls-files "*.go" | wc -l',
  "git status --short",
  "git status && git log --oneline -3",
  "sed -n 1,80p AGENTS.md",
  "git status && go version && go list ./... | head -1",
  "  go version  ",
  "go version;go list ./...",
  "kubectl apply --write -f deployment.yaml",
  "kubectl apply 'literal; touch output | rm file'",
  "kubectl apply escaped\\;argument",
  "git rev-parse $PI_PLAN_GIT_ARGUMENTS",
])("Bash retains trusted arguments and legitimate chains: %s", (command) => {
  assert.equal(findBlockedCommandSegment(command, safeSubcommands), undefined);
  assert.equal(isSafeCommand(command, safeSubcommands), true);
});

test.each([
  "go versions",
  "Go version",
  "go version-extra",
  "go  version",
  "go 'version'",
  "kubectl applies -f deployment.yaml",
])("Bash preserves literal configured-prefix matching: %s", (command) => {
  assert.equal(findBlockedCommandSegment(command, safeSubcommands), command);
});

test.each([
  "go version > output",
  "go version < input",
  "go version 2>&1 | head -1",
  "go version $(touch output)",
  'kubectl apply "$(touch output)"',
  'kubectl apply "$(echo args; touch output)"',
  "go version `touch output`",
  "go version\ntouch output",
  "go version\rtouch output",
  "go version & touch output",
  "go version &&",
  "go version && && git status",
  "go version 'unterminated",
  "go version trailing\\",
])("Bash rejects parser-unsupported syntax before trusting a prefix: %s", (command) => {
  assert.equal(findBlockedCommandSegment(command, safeSubcommands), command);
  assert.equal(isSafeCommand(command, safeSubcommands), false);
});

test.each([
  ["go version && git push origin main", "git push origin main"],
  ["go version && go env -w GOFLAGS=-mod=mod", "go env -w GOFLAGS=-mod=mod"],
  ["go version && gofmt -w server", "gofmt -w server"],
  ["go version && echo $HOME", "echo $HOME"],
  ["go version && FOO=1 ls", "FOO=1 ls"],
  ["go version && git blame -- file", "git blame -- file"],
  ["go version && ssh host ls", "ssh host ls"],
  ["go version && curl -o out http://example.com", "curl -o out http://example.com"],
])("Bash retains default checks for untrusted segments: %s", (command, blocked) => {
  assert.equal(findBlockedCommandSegment(command, safeSubcommands), blocked);
});

test.each([";", "|"])("PowerShell evaluates all segments separated by %s", (separator) => {
  for (const command of [
    `Invoke-Trusted run ${separator} Remove-Item src`,
    `Remove-Item src ${separator} Invoke-Trusted run`,
    `Get-Location ${separator} Invoke-Trusted run ${separator} Remove-Item src`,
    `Invoke-Trusted run ${separator} Remove-Item src ${separator} Get-Location`,
  ]) {
    assert.equal(findBlockedPowerShellCommandSegment(command, safeSubcommands), "Remove-Item src", command);
  }
  assert.equal(
    isSafePowerShellCommand(`Get-Location ${separator} Invoke-Trusted run ${separator} Out-String`, safeSubcommands),
    true,
  );
});

test.each([
  "Invoke-Trusted run --write",
  "Invoke-Trusted run 'literal; Remove-Item src | Set-Content output changed'",
  "Invoke-Trusted run 'it''s literal; Remove-Item src'",
  "Get-Location; Invoke-Trusted run; git rev-parse HEAD | Out-String",
  "  Invoke-Trusted run  ",
])("PowerShell retains trusted commands, literal arguments, and safe chains: %s", (command) => {
  assert.equal(findBlockedPowerShellCommandSegment(command, safeSubcommands), undefined);
  assert.equal(isSafePowerShellCommand(command, safeSubcommands), true);
});

test.each(["Invoke-Trusted runner", "invoke-trusted run", "Invoke-Trusted  run", "Invoke-Trusted 'run'"])(
  "PowerShell preserves literal configured-prefix matching: %s",
  (command) => {
    assert.equal(findBlockedPowerShellCommandSegment(command, safeSubcommands), command);
  },
);

test.each([
  "Invoke-Trusted run > output",
  "Invoke-Trusted run < input",
  "Invoke-Trusted run $(Remove-Item src)",
  'Invoke-Trusted run "$(Remove-Item src)"',
  "Invoke-Trusted run $env:PI_MODEL",
  "Invoke-Trusted run `argument",
  "Invoke-Trusted run\nRemove-Item src",
  "Invoke-Trusted run && Get-Location",
  "Invoke-Trusted run || Get-Location",
  "Invoke-Trusted run;",
  "Invoke-Trusted run;; Get-Location",
  "Invoke-Trusted run 'unterminated",
  "Invoke-Trusted run { Remove-Item src }",
  "Invoke-Trusted run # comment",
  "Invoke-Trusted run \u2018argument\u2019",
])("PowerShell rejects parser-unsupported syntax before trusting a prefix: %s", (command) => {
  assert.equal(findBlockedPowerShellCommandSegment(command, safeSubcommands), command);
  assert.equal(isSafePowerShellCommand(command, safeSubcommands), false);
});
