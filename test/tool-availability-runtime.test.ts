import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "./support.js";

const fixtures = [
  { label: "additive defaults", existing: undefined, additive: true, inMemory: false },
  { label: "additive custom exclusion", existing: ["-bash"], additive: true, inMemory: false },
  { label: "full default selection", existing: undefined, additive: false, inMemory: false },
  { label: "intentional empty selection", existing: [], additive: false, inMemory: false },
  { label: "host-owned in-memory selection", existing: ["read", "edit", "write"], additive: false, inMemory: true },
];

for (const fixture of fixtures) {
  test(`Pi settings enable search tools after restart, preserving ${fixture.label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-availability-sdk-"));
    const agentDir = join(root, "session-agent");
    const processAgentDir = join(root, "process-agent");
    const settingsPath = join(agentDir, "settings.json");
    const processSettingsPath = join(processAgentDir, "settings.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(agentDir);
      await mkdir(processAgentDir);
      const processSettings = JSON.stringify({ defaultTools: ["read"] });
      await writeFile(processSettingsPath, processSettings);
      let current = { ...(fixture.existing ? { defaultTools: fixture.existing } : {}), retained: { value: true } };
      await writeFile(settingsPath, JSON.stringify(current));
      // The SDK's session agentDir and settings storage need not match the process default.
      process.env.PI_CODING_AGENT_DIR = processAgentDir;
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      for (const restarted of [false, true]) {
        if (restarted) {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session?.dispose();
          session = undefined;
          current = {
            ...current,
            defaultTools: fixture.additive
              ? [...(current.defaultTools ?? []), "+grep", "+find", "+ls"]
              : [...(current.defaultTools ?? ["read", "bash", "edit", "write"]), "grep", "find", "ls"],
          };
          if (!fixture.inMemory) await writeFile(settingsPath, JSON.stringify(current));
        }
        const settingsManager = fixture.inMemory
          ? SettingsManager.inMemory(current)
          : SettingsManager.create(root, agentDir);
        const loader = new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          additionalExtensionPaths: [resolve(".")],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const created = await createAgentSession({
          cwd: root,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(root),
        });
        session = created.session;
        const rpc = createRpcHarness([
          { kind: "select", response: "Plan policy tools (Automatic safe built-ins)" },
          { kind: "select", response: undefined },
          { kind: "select", response: undefined },
          { kind: "select", response: undefined },
        ]);
        const errors: unknown[] = [];
        const context = createMockContext({ cwd: root, mode: "rpc", hasUI: true, ...rpc.ui });
        await session.bindExtensions({
          mode: "rpc",
          uiContext: (context.ctx as ExtensionContext).ui,
          onError: (error) => errors.push(error),
        });
        const before = {
          active: session.getActiveToolNames(),
          tools: JSON.stringify(session.getAllTools()),
          prompt: session.systemPrompt,
          messages: JSON.stringify(session.agent.state.messages),
          settings: await readFile(settingsPath, "utf8"),
          effectiveSettings: JSON.stringify(settingsManager.getSettings()),
          branch: JSON.stringify(session.sessionManager.getBranch()),
        };
        await session.prompt("/plan settings");
        await session.prompt("/plan tools");
        rpc.assertConsumed();
        assert.equal(rpc.dialogs.length, 4);
        assert.match(rpc.dialogs[3]?.title ?? "", /^Choose Plan policy allowlist/);
        for (const options of [rpc.dialogs[1]?.options ?? [], rpc.dialogs[3]?.options ?? []]) {
          for (const name of ["grep", "find", "ls"]) {
            assert.equal(before.active.includes(name), restarted);
            if (restarted) assert.ok(options.includes(`[x] ${name}`));
            else {
              const row = options.find((option) => option.includes(`${name} — inactive in Pi`)) ?? "";
              assert.match(row, /defaultTools/);
              assert.match(row, /this session's Pi settings/);
              assert.doesNotMatch(row, /settings\.json|"\+(grep|find|ls)"/);
              assert.ok(!row.includes(processAgentDir));
            }
          }
          for (const name of ["edit", "write"]) {
            assert.ok(options.some((option) => option.includes(`${name} — blocked by Plan policy`)));
          }
        }
        const baseline =
          fixture.existing === undefined
            ? ["read", "bash", "edit", "write"]
            : fixture.existing[0] === "-bash"
              ? ["read", "edit", "write"]
              : fixture.existing;
        for (const name of ["read", "bash", "edit", "write"]) {
          assert.equal(before.active.includes(name), baseline.includes(name));
        }
        assert.deepEqual(session.getActiveToolNames(), before.active);
        assert.equal(JSON.stringify(session.getAllTools()), before.tools);
        assert.equal(session.systemPrompt, before.prompt);
        assert.equal(JSON.stringify(session.agent.state.messages), before.messages);
        assert.equal(JSON.stringify(session.sessionManager.getBranch()), before.branch);
        assert.equal(await readFile(settingsPath, "utf8"), before.settings);
        assert.equal(JSON.stringify(settingsManager.getSettings()), before.effectiveSettings);
        assert.equal(await readFile(processSettingsPath, "utf8"), processSettings);
        assert.deepEqual(JSON.parse(before.effectiveSettings).retained, { value: true });
        assert.deepEqual(errors, []);
        assert.deepEqual(
          context.notifications.filter(({ level }) => level === "error"),
          [],
        );
      }
    } finally {
      try {
        await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}
