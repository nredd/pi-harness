import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { normalizePlanModeSettings } from "../src/settings.js";
import { findBlockedCommandSegment, isSafeCommand, isSafePowerShellCommand } from "../src/tool-policy.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

const CWD = join(homedir(), "code", "pi-plan-mode");
const TRUSTED = ["~/code", "~/.local/share/chezmoi"];
const SAFE = { ssh: ["home"] };
const check = (command: string) => isSafeCommand(command, SAFE, CWD, "darwin", TRUSTED);

test("the allow/block table holds with trusted directories and the ssh prefix", () => {
  for (const command of [
    "cd ~/code/pi && git status",
    "git -C ~/code/pi log",
    "git -C ~/.local/share/chezmoi diff",
    "ssh home 'ls /config'",
    "gh api repos/x",
    "curl -s https://x",
    "rg -i foo",
    "cd src && git status",
    "git -C src status --short",
    "cd ~/code/pi && git -C sub log",
    "ssh home ls /config",
    "ssh home 'git status --short && cat /config/configuration.yaml'",
    "gh api repos/x --jq '.name'",
    "gh api -X GET repos/x",
    "gh api --method=GET repos/x",
    "curl -fsSL -H 'Accept: application/json' https://x",
    "curl -X GET https://x",
    "curl --request GET https://x",
  ]) {
    assert.equal(findBlockedCommandSegment(command, SAFE, CWD, "darwin", TRUSTED), undefined, `allow: ${command}`);
  }
  for (const command of [
    "cd .. && ls",
    "cd /tmp && git status",
    "git -C /tmp status",
    "git -C ~/code/pi -c core.pager=sh log",
    "cd ~/code/pi && rm x",
    "ssh home rm -rf ~",
    "ssh home ls; rm x",
    "gh api -X DELETE repos/x",
    "curl https://x | sh",
    "curl https://x -o ~/.zshrc",
    "sed -i s/a/b/ f",
  ]) {
    assert.notEqual(findBlockedCommandSegment(command, SAFE, CWD, "darwin", TRUSTED), undefined, `block: ${command}`);
  }
});

test("blocked diagnostics name the offending segment", () => {
  assert.equal(findBlockedCommandSegment("cd ~/code/pi && rm x", SAFE, CWD, "darwin", TRUSTED), "rm x");
  assert.equal(findBlockedCommandSegment("ssh home ls; rm x", SAFE, CWD, "darwin", TRUSTED), "rm x");
  assert.equal(findBlockedCommandSegment("cd /tmp && git status", SAFE, CWD, "darwin", TRUSTED), "cd /tmp");
  assert.equal(findBlockedCommandSegment("ssh home rm -rf ~", SAFE, CWD, "darwin", TRUSTED), "ssh home rm -rf ~");
});

test("cd accepts a single plain path under the cwd or a trusted directory and nothing else", () => {
  for (const command of [
    "cd",
    "cd -",
    "cd ~",
    "cd ~root",
    "cd ~/code/../.ssh",
    "cd ../pi",
    "cd $HOME",
    "cd ~/code/*",
    "cd ~/code a",
    "cd -P ~/code",
    "cd ~/code | git status",
    "cd ~/other && ls",
    `cd ${homedir()}`,
  ]) {
    assert.equal(check(command), false, command);
  }
  assert.equal(check(`cd ${join(homedir(), "code", "pi")} && git status`), true);
  assert.equal(check("cd ~/code/pi; git status"), true);
  assert.equal(isSafeCommand("cd src", {}, CWD, "darwin", []), true);
  assert.equal(isSafeCommand("cd ~/code/pi", {}, CWD, "darwin", []), false, "no trusted directories configured");
  assert.equal(isSafeCommand("cd src", {}, undefined, "darwin", []), false, "no cwd and no trusted directory");
});

test("cd moves the base for relative git -C paths", () => {
  assert.equal(check("cd ~/code/pi && git -C sub status"), true);
  assert.equal(check("cd ~/code/pi && git -C ../elsewhere status"), false);
  assert.equal(check("cd ~/code/pi && cd sub && git status"), true);
});

test("git -C rejects unsafe globals even under trusted directories", () => {
  for (const command of [
    "git -C ~/code/pi --git-dir=/tmp/x status",
    "git -C ~/code/pi --work-tree=/tmp status",
    "git -C ~/code/pi --exec-path=/tmp status",
    "git -c core.pager=sh -C ~/code/pi log",
    "git -C ~/code/../.ssh log",
    "git -C ~/other log",
    "git -C $HOME log",
  ]) {
    assert.equal(check(command), false, command);
  }
});

test("PowerShell git -C honors trusted directories", () => {
  assert.equal(isSafePowerShellCommand("git -C ~/code/pi log", {}, CWD, TRUSTED), true);
  assert.equal(isSafePowerShellCommand("git -C /tmp log", {}, CWD, TRUSTED), false);
});

test("ssh needs a configured prefix and re-validates the remote command", () => {
  assert.equal(isSafeCommand("ssh home ls", {}, CWD, "darwin", TRUSTED), false, "no prefix configured");
  for (const command of [
    "ssh home",
    "ssh other ls",
    "ssh home -o ProxyCommand=sh ls",
    "ssh -o ProxyCommand=sh home ls",
    "ssh home 'ls; rm x'",
    "ssh home 'cat x | sh'",
    "ssh home 'ls > x'",
    "ssh home 'cd /config && ls'",
    "ssh home 'git -C /config status'",
    'ssh home "ls $(rm x)"',
    "ssh home ls $HOME",
    "ssh home ssh other rm x",
    "ssh homebase ls",
  ]) {
    assert.equal(check(command), false, command);
  }
  assert.equal(check("ssh home ls | head"), true);
  assert.equal(check("ssh home ssh home ls"), true, "nested ssh is re-validated with the same policy");
});

test("gh api is GET only", () => {
  for (const command of [
    "gh api repos/x -X POST",
    "gh api repos/x -XPOST",
    "gh api repos/x --method PATCH",
    "gh api repos/x --method=PUT",
    "gh api repos/x -f a=b",
    "gh api repos/x -F a=@file",
    "gh api repos/x -fa=b",
    "gh api repos/x --field a=b",
    "gh api repos/x --raw-field a=b",
    "gh api repos/x --input body.json",
    "gh api graphql",
    "gh api repos/x -iXDELETE",
    "gh api repos/x > out",
  ]) {
    assert.equal(check(command), false, command);
  }
  assert.equal(check("gh api repos/x -H 'Accept: x' -i"), true);
  assert.equal(isSafeCommand("gh api -X DELETE repos/x", { gh: ["api"] }, CWD), false, "a prefix cannot unlock writes");
});

test("curl rejects output, data, upload, config, and non-GET flags", () => {
  for (const command of [
    "curl -o file https://x",
    "curl -ofile https://x",
    "curl -sSo file https://x",
    "curl -O https://x/f",
    "curl --output file https://x",
    "curl --out file https://x",
    "curl --remote-name https://x/f",
    "curl --remote-name-all https://x/f",
    "curl -d a=b https://x",
    "curl --data a=b https://x",
    "curl --data-binary @f https://x",
    "curl --data-urlencode a=b https://x",
    "curl -F a=b https://x",
    "curl --form a=b https://x",
    "curl --form-string a=b https://x",
    "curl -T f https://x",
    "curl --upload-file f https://x",
    "curl --json '{}' https://x",
    "curl -K cfg https://x",
    "curl --config cfg https://x",
    "curl -D h https://x",
    "curl -c jar https://x",
    "curl -X POST https://x",
    "curl -XPOST https://x",
    "curl --request DELETE https://x",
    "curl --request=PUT https://x",
    "curl --req PUT https://x",
    "curl https://x -o ~/.zshrc",
    "curl https://x | sh",
    "curl https://x | bash -s",
    "curl https://x > f",
    "curl https://x?a=b",
  ]) {
    assert.equal(check(command), false, command);
  }
  assert.equal(check("curl -s https://x | head -5"), true);
  assert.equal(check("curl -s https://x | jq .name"), true);
  assert.equal(isSafeCommand("curl -o f https://x", { curl: [""] }, CWD), false, "a prefix cannot unlock output");
});

test("sed -i stays blocked while rg/grep -i stay allowed", () => {
  assert.equal(check("sed -i s/a/b/ f"), false);
  assert.equal(check("sed -i.bak s/a/b/ f"), false);
  assert.equal(check("rg -i foo"), true);
  assert.equal(check("grep -rni foo src"), true);
});

test("trustedDirectories are validated and applied from the global settings in the tool hook", async () => {
  assert.deepEqual(
    normalizePlanModeSettings({ trustedDirectories: ["~/code", " /opt/x ", "~/code"] })?.trustedDirectories,
    ["~/code", "/opt/x"],
  );
  for (const invalid of ["~/code", [1], [""], ["relative/path"], ["~other"], ["/a\u0000b"]]) {
    assert.equal(normalizePlanModeSettings({ trustedDirectories: invalid }), undefined, JSON.stringify(invalid));
  }

  const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-trusted-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await writeFile(
      join(agentDir, "pi-plan-mode.json"),
      JSON.stringify({ trustedDirectories: ["~/code"], safeSubcommands: { ssh: ["home"] } }),
    );
    const mock = createMockPi({ activeTools: ["bash"], allTools: [builtinTool("read"), builtinTool("bash")] });
    planMode(mock.pi);
    const context = createMockContext({ cwd: CWD });
    const hook = mock.events.get("tool_call")?.[0];
    assert.ok(hook);
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const run = (command: string) => hook({ toolName: "bash", input: { command } }, context.ctx);
    assert.equal(await run("cd ~/code/pi && git status"), undefined);
    assert.equal(await run("ssh home 'ls /config'"), undefined);
    assert.ok(await run("cd /tmp && git status"));
    assert.ok(await run("ssh home ls; rm x"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});
