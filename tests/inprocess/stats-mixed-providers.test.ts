/** Mixed physical providers through the real session transcript and `/stats` overlay. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerGoogleFauxProvider } from "@nredd/pi-test-lib/faux";
import { fauxAssistantMessage, registerFauxProvider } from "@nredd/pi-test-lib/harness";
import { expect, it } from "vitest";
import { configFor } from "../../packages/session-kit/tests/fixtures/session.ts";
import { assistant, chart, history, layout } from "../../packages/session-kit/tests/fixtures/stats.ts";
import { TerminalFixture } from "../../packages/session-kit/tests/fixtures/terminal.ts";
import { isolateStackHome } from "./support.ts";

it("counts three providers in one session with thinking included in output", async () => {
	const home = await isolateStackHome();
	const fixture = new TerminalFixture();
	const registered: { unregister(): void }[] = [];
	const anthropic = registerFauxProvider({
		api: "fixture-anthropic",
		provider: "anthropic",
		models: [{ id: "claude-opus-5-5" }],
	});
	const codex = registerFauxProvider({
		api: "fixture-codex",
		provider: "openai-codex",
		models: [{ id: "gpt-6.1-sol" }],
	});
	const google = registerGoogleFauxProvider();
	registered.push(anthropic, codex, google);
	const turns = [
		{ mock: anthropic, input: 10, output: 20, reasoning: 0, cacheRead: 30, costUsd: 0.12, daysAgo: 3 },
		{ mock: codex, input: 11, output: 21, reasoning: 0, cacheRead: 31, costUsd: 0.23, daysAgo: 2 },
		{ mock: google, input: 12, output: 22, reasoning: 7, cacheRead: 42, costUsd: 0.34, daysAgo: 1 },
	] as const;
	try {
		const host = await fixture.startTerminal(configFor("stats"), {
			columns: 160,
			rows: 50,
			sessionManager: SessionManager.create(fixture.root, join(fixture.agentDir, "sessions", "--mixed--")),
			useModelRuntimeStream: true,
			fauxProvider: anthropic,
			extensionFactories: [
				(pi) => {
					for (const mock of [codex, google]) {
						pi.registerProvider(mock.getModel().provider, {
							apiKey: "fixture-key",
							api: mock.api,
							models: mock.models,
						});
					}
					// Script recorded usage at the public persistence seam: the faux transport estimates its own tokens.
					pi.on("message_end", ({ message }) => {
						if (message.role !== "assistant" || message.stopReason !== "stop") return;
						const turn = turns.find(({ mock }) => mock.getModel().provider === message.provider);
						if (!turn) return;
						const { input, output, reasoning, cacheRead, costUsd, daysAgo } = turn;
						return {
							message: {
								...message,
								timestamp: fixture.clock.now() - daysAgo * 86_400_000,
								usage: {
									input,
									output,
									reasoning,
									cacheRead,
									cacheWrite: 0,
									totalTokens: input + output + cacheRead,
									cost: { ...message.usage.cost, total: costUsd },
								},
							},
						};
					});
				},
			],
		});
		const session = host.harness.session;
		for (const { mock } of turns) {
			const model = mock.getModel();
			mock.setResponses([fauxAssistantMessage("Offline fixture", { timestamp: fixture.clock.now() })]);
			await session.setModel(model);
			await session.prompt(`Ask ${model.provider}`);
			expect(mock.state.callCount).toBe(1);
		}

		await fixture.open("/stats");
		const overview = layout(fixture);
		expect(overview).toMatch(/Total tokens +199\b/);
		expect(overview).toMatch(/Sessions +1\b/);
		expect(overview).toMatch(/Recorded cost +\$0\.69\b/);
		chart(overview);
		expect(overview).toMatch(/Tokens per .*by provider.*● google.*● openai-codex.*● anthropic/);

		await fixture.key("\t");
		const models = layout(fixture);
		// Match the full headings and row cells: no thinking column, no double-count, no lost cache reads.
		expect(models).toMatch(/^ +Tokens +Share +In +Out +Cache read +Cache write +Recorded cost$/m);
		expect(models).toMatch(/gpt-6\.1-sol +63 +[\d.]+% +11 +21 +31 +0 +\$0\.23$/m);
		expect(models).toMatch(/gemini-4-carbon +76 +[\d.]+% +12 +22 +42 +0 +\$0\.34$/m);
		await fixture.key("j".repeat(20));
		expect(layout(fixture)).toMatch(/claude-opus-5-5 +60 +[\d.]+% +10 +20 +30 +0 +\$0\.12$/m);
		await fixture.close();
	} finally {
		try {
			await fixture.dispose();
		} finally {
			for (const mock of registered) mock.unregister();
			await home.cleanup();
		}
	}
});

it("documents that absent Pi recorded cost currently renders as zero (#799)", async () => {
	const home = await isolateStackHome();
	const fixture = new TerminalFixture();
	try {
		const entry = assistant(fixture.clock.now() - 3_600_000, "google", "gemini-4-unpriced-test", 2);
		const { input, output, cacheRead, cacheWrite, totalTokens } = entry.message.usage;
		history(fixture.agentDir, [
			{ ...entry, message: { ...entry.message, usage: { input, output, cacheRead, cacheWrite, totalTokens } } },
		]);
		await fixture.startTerminal(configFor("stats"), { columns: 160, rows: 50 });
		await fixture.open("/stats");
		await fixture.key("\t");
		// Replace this oracle when the persisted history/cost contract can distinguish missing from recorded zero.
		const models = layout(fixture);
		expect(models).toMatch(/gemini-4-unpriced-test +52 +100\.0% +4 +2 +40 +6 +\$0\.00$/m);
		expect(models).toContain("Pricing coverage: 0 priced / 1 unpriced events");
		await fixture.close();
	} finally {
		try {
			await fixture.dispose();
		} finally {
			await home.cleanup();
		}
	}
});
