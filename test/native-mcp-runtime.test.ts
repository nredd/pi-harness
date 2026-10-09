import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";

test("native MCP calls use Plan's opt-in policy through the real nested tool pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-native-mcp-"));
  const agentDir = join(root, "agent");
  const callLog = join(root, "calls.log");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await mkdir(agentDir);
    await writeFile(callLog, "");
    await writeFile(
      join(agentDir, "pi-plan-mode.json"),
      JSON.stringify({
        defaultPlanTools: [
          "bash",
          "codemode",
          "tool_search",
          "mcp__fixture__direct",
          "mcp__fixture__callable",
          "mcp__fixture__deferred",
          "mcp__fixture__cd_deferred",
        ],
      }),
    );
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [resolve("test/fixtures/native-mcp-server.mjs"), callLog],
            exposure: "codemode",
            toolExposure: {
              direct: "direct",
              deferred: "deferred",
              cd_deferred: "codemode-deferred",
              hidden: "hidden",
            },
          },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fauxModule = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
    const faux = fauxModule.createFauxCore({
      api: `plan-mcp-${crypto.randomUUID()}`,
      provider: `plan-mcp-${crypto.randomUUID()}`,
      models: [{ id: "plan-fixture", contextWindow: 100_000, maxTokens: 4_000 }],
    });
    faux.setResponses([
      fauxModule.fauxAssistantMessage([
        fauxModule.fauxToolCall("mcp__fixture__direct", {}),
        fauxModule.fauxToolCall("codemode", {
          code: `
          for (const name of ["callable", "deferred", "cd_deferred", "unselected", "hidden"]) {
            try { console.log(await tools["mcp__fixture__" + name]({})); }
            catch (error) { console.log(String(error)); }
          }
          try { await tools.write({ path: "forbidden.txt", content: "never" }); }
          catch (error) { console.log(String(error)); }
          try { await tools.bash({ command: "touch forbidden.txt" }); }
          catch (error) { console.log(String(error)); }
        `,
        }),
        fauxModule.fauxToolCall("tool_search", { query: "unselected", limit: 1 }),
      ]),
      fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall("mcp__fixture__unselected", {})),
      fauxModule.fauxAssistantMessage("done"),
    ]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "local-fixture",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const model = registry.find(faux.provider, "plan-fixture");
    assert.ok(model);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        resolve("src/index.ts"),
        "builtin:codemode",
        "builtin:mcp",
        "builtin:tool-search",
      ],
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
        { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
        {
          name: "mcp",
          builtin: true,
          // Use Pi's config loader so legacy exposure aliases are normalized.
          factory: createMcpExtension(),
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    session = created.session;
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    // /mcp awaits startup: no timing sleeps or model-provider request.
    await session.prompt("/mcp");
    const active = session.getActiveToolNames();
    assert.ok(active.includes("codemode"));
    assert.ok(!active.includes("mcp__fixture__callable"));
    const metadata = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const [name, exposure] of Object.entries({
      direct: "direct",
      // Pi 1.0 maps MCP codemode exposure to deferred; earlier Pi lists it inline.
      // Keep the exact expectation for each contract while testing the same policy.
      callable: Number(VERSION.split(".")[0]) >= 1 ? "deferred" : "codemode",
      deferred: "deferred",
      cd_deferred: "deferred",
      hidden: "hidden",
    })) {
      const tool = metadata.get(`mcp__fixture__${name}`);
      assert.equal(tool?.exposure, exposure);
      assert.equal(tool?.sourceInfo.source, "builtin");
      assert.equal(tool?.sourceInfo.path, "builtin:mcp");
    }
    await session.prompt("/plan start");
    await session.prompt("Exercise the local tool policy fixture.");
    assert.equal(faux.state.callCount, 3);
    assert.deepEqual((await readFile(callLog, "utf8")).trim().split("\n").sort(), [
      "callable",
      "cd_deferred",
      "deferred",
      "direct",
    ]);
    const transcript = JSON.stringify(session.agent.state.messages);
    assert.match(transcript, /not selected by the Plan policy/);
    assert.match(transcript, /blocks mutating tool/);
    assert.match(transcript, /blocks bash commands outside/);
    await assert.rejects(access(join(root, "forbidden.txt")));
    assert.doesNotMatch(transcript, /fixture:unselected|fixture:hidden/);
    assert.match(transcript, /Loaded 1 tool/);
    // Pi's explicitly selected tool_search declares a tool, but Plan's frozen policy
    // still denies it; this external transition is not a Plan-owned activation.
    assert.deepEqual(session.getActiveToolNames(), [...active, "mcp__fixture__unselected"]);
    assert.deepEqual(errors, []);
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
