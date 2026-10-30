/** Real child-session regression for trusted named-skill composition. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

const TRUSTED = "TRUSTED-SKILL";
const HOSTILE = "HOSTILE-PROJECT-SKILL";
const PACKAGED = "PACKAGED-SKILL";

function writeSkill(root: string, name: string, content: string): void {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${content}\n`);
}

function writeScout(agentDir: string): void {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: scout\ntools: read\nskills: review\nextensions: false\n---\nScout.\n");
}

describe("preloaded skills in real child prompts", () => {
  let run: PrintModeRun | undefined;
  let fixture: Hermetic | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    fixture?.restore();
    fixture = undefined;
    cwd = undefined;
  });

  it("keeps an untrusted project skill out of the child prompt", async () => {
    fixture = hermeticDir();
    cwd = fixture.dir;
    const projectSkill = join(cwd, ".pi", "skills", "review");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(projectSkill, "SKILL.md"), `---\nname: review\ndescription: hostile\n---\n${HOSTILE}\n`);

    let childPrompt = "";
    const respond = (context: Context): FauxReply => {
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes('active_agent name=\\"scout\\"')) {
        childPrompt = transcript;
        return "child done";
      }
      if (context.messages.some((message) => message.role === "toolResult")) return "parent done";
      return agentCall({ subagent_type: "scout", description: "check", prompt: "check", run_in_background: false });
    };

    run = await runPrintMode({
      prompt: "check",
      cwd,
      live: false,
      projectTrusted: false,
      respond,
      beforeRun: () => {
        const agentDir = getAgentDir();
        const skillDir = join(agentDir, "skills", "review");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `---\nname: review\ndescription: trusted\n---\n${TRUSTED}\n`);
        const agentsDir = join(agentDir, "agents");
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(join(agentsDir, "scout.md"), "---\nname: scout\ndescription: scout\ntools: read\nskills: review\nextensions: false\n---\nScout.\n");
        registerAgents(loadCustomAgents(cwd!, false, { projectTrusted: false }));
      },
    });

    expect(childPrompt).toContain(TRUSTED);
    expect(childPrompt).not.toContain(HOSTILE);
  });

  it("adds a configured package skill to a real child prompt", async () => {
    fixture = hermeticDir();
    cwd = fixture.dir;
    const packageRoot = join(cwd, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", PACKAGED);

    let childPrompt = "";
    const respond = (context: Context): FauxReply => {
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes('active_agent name=\\"scout\\"')) {
        childPrompt = transcript;
        return "child done";
      }
      if (context.messages.some((message) => message.role === "toolResult")) return "parent done";
      return agentCall({ subagent_type: "scout", description: "check", prompt: "check", run_in_background: false });
    };

    run = await runPrintMode({
      prompt: "check",
      cwd,
      live: false,
      projectTrusted: false,
      respond,
      beforeRun: () => {
        const agentDir = getAgentDir();
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
        writeScout(agentDir);
        registerAgents(loadCustomAgents(cwd!, false, { projectTrusted: false }));
      },
    });

    expect(childPrompt).toContain(PACKAGED);
  });
});
