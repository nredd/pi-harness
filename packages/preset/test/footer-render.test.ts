/** Direct renderer contracts complement the real-host lifecycle/width scenarios. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createExpandedFooter } from "../extensions/expanded-footer.ts";
import { FakeClock } from "./scenarios/support.ts";

type Factory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

/** Only fields read by the renderer are supplied; casts mark this isolated host boundary. */
async function mount(useDefaultClock = false, homeDir?: string) {
	const clock = new FakeClock();
	let start: ((_event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	let factory: Factory | undefined;
	const off = vi.fn();
	const render = vi.fn();
	const emit = vi.fn();
	let quotaReply: ((data: unknown) => void) | undefined;
	let branchChanged = () => {};
	const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost: { total: 0.125 } };
	const entries: unknown[] = [];
	const model = { id: "example", provider: "example-provider", reasoning: true, contextWindow: 128000 };
	const ctx = {
		mode: "tui",
		cwd: join(process.env.HOME || process.env.USERPROFILE || homedir(), "project"),
		model,
		thinkingLevel: "high",
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => undefined as { percent: number | null; contextWindow: number } | undefined,
		sessionManager: { getEntries: () => entries, getBranch: () => [], getSessionName: () => "session" },
		ui: {
			setFooter: (value: Factory) => {
				factory = value;
			},
		},
	};
	const pi = {
		on: (name: string, handler: typeof start) => {
			if (name === "session_start") start = handler;
		},
		events: {
			on: (_channel: string, handler: (data: unknown) => void) => {
				quotaReply = handler;
				return off;
			},
			emit,
		},
	};
	await createExpandedFooter(useDefaultClock ? { homeDir } : { clock, homeDir })(pi as unknown as ExtensionAPI);
	await start?.({}, ctx as unknown as ExtensionContext);
	if (!factory) throw new Error("Footer not mounted");
	const paint = vi.fn((_color: string, text: string) => text);
	const component = factory(
		{ requestRender: render } as unknown as Parameters<Factory>[0],
		{ fg: paint } as unknown as Parameters<Factory>[1],
		{
			onBranchChange: (callback: () => void) => {
				branchChanged = callback;
				return off;
			},
			getGitBranch: () => "feature",
			getAvailableProviderCount: () => 2,
			getExtensionStatuses: () =>
				new Map([
					["z", "last\n\t status"],
					["a", " first  status "],
				]),
		},
	);
	return { ctx, entries, usage, component, paint, clock, off, render, emit, branchChanged, reply: () => quotaReply };
}

it("default clock polls on cadence and disposal cancels native timers", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse("2026-10-19T12:00:00Z"));
	let component: Awaited<ReturnType<typeof mount>>["component"] | undefined;
	try {
		const f = await mount(true);
		component = f.component;
		f.component.render(240);
		expect(vi.getTimerCount()).toBe(1); // Deferred poller start.
		expect(f.emit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(f.emit).toHaveBeenCalledOnce();
		expect(f.emit).toHaveBeenLastCalledWith("router:rpc:usage", {
			requestId: expect.any(String),
			refresh: true,
		});
		expect(vi.getTimerCount()).toBe(2); // Reply deadline and cadence.
		f.reply()?.({
			success: true,
			data: {
				snapshots: [
					{
						provider: "anthropic",
						status: "available",
						expiresAt: Date.now() + 5_000,
						windows: [{ name: "five_hour", scope: "provider", usedPercent: 24 }],
					},
				],
			},
		});
		expect(f.component.render(240)[2]).toContain("Anthropic 5h 76%");
		vi.advanceTimersByTime(5_000);
		expect(f.component.render(240)[2]).toContain("Anthropic (stale) 5h 76%");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(55_000);
		expect(vi.getTimerCount()).toBe(2); // A second unanswered request.
		expect(f.emit).toHaveBeenCalledTimes(2);
		f.component.dispose?.();
		expect(f.off).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		const renders = f.render.mock.calls.length;
		vi.advanceTimersByTime(120_000);
		expect(f.emit).toHaveBeenCalledTimes(2);
		expect(f.render).toHaveBeenCalledTimes(renders);
	} finally {
		component?.dispose?.();
		vi.useRealTimers();
	}
});

it("totals include every live usage entry type, not custom messages", async () => {
	const f = await mount();
	try {
		f.entries.push(
			{ type: "usage", usage: f.usage },
			{ type: "message", message: { role: "assistant", usage: f.usage } },
			{ type: "message", message: { role: "toolResult", usage: f.usage } },
			{ type: "compaction", usage: f.usage },
			{ type: "branch_summary", usage: f.usage },
			{ type: "custom_message", message: { role: "assistant", usage: f.usage } },
			{ type: "message", message: { role: "toolResult" } },
		);
		expect(f.component.render(240)[1]).toContain("in 500 out 100 read 1.5k write 200 cost $0.625 ctx ?/128k (auto)");
	} finally {
		f.component.dispose?.();
	}
});

it.each([
	[999, "999"],
	[1000, "1.0k"],
	[9999, "10.0k"],
	[10000, "10k"],
	[999999, "1000k"],
	[1000000, "1.0M"],
	[9999999, "10.0M"],
	[10000000, "10M"],
] as const)("token formatting boundary %s", async (input, formatted) => {
	const f = await mount();
	try {
		f.entries.push({ type: "usage", usage: { ...f.usage, input } });
		expect(f.component.render(240)[1]).toContain(`in ${formatted} out`);
	} finally {
		f.component.dispose?.();
	}
});

it("uses the injected home when formatting the cwd", async () => {
	const f = await mount(false, "/isolated/home");
	try {
		f.ctx.cwd = "/isolated/home/project";
		expect(f.component.render(240)[0]).toBe("~/project (feature) • session");
	} finally {
		f.component.dispose?.();
	}
});

it("cwd branch session and sorted sanitized statuses preserve their rows", async () => {
	const f = await mount();
	try {
		const rows = f.component.render(240);
		expect(rows[0]).toBe("~/project (feature) • session");
		expect(rows[2]).toBe("first status last status");
		f.branchChanged();
		expect(f.render).toHaveBeenCalledOnce();
	} finally {
		f.component.dispose?.();
	}
	expect(f.off).toHaveBeenCalled();
	expect(f.clock.pending).toBe(0);
});

it.each([
	[70, undefined],
	[70.1, "warning"],
	[90, "warning"],
	[90.1, "error"],
] as const)("context threshold %s has expected styling", async (percent, color) => {
	const f = await mount();
	try {
		f.ctx.getContextUsage = () => ({ percent, contextWindow: 1000000 });
		expect(f.component.render(240)[1]).toContain(`ctx ${percent.toFixed(1)}%/1.0M (auto)`);
		const warnings = f.paint.mock.calls.filter(([key]) => key === "warning" || key === "error");
		expect(warnings.map(([key]) => key)).toEqual(color ? [color, color] : []);
	} finally {
		f.component.dispose?.();
	}
});

it.each(["kimi-coding", "oauth", "api-key"])("subscription cost detection: %s", async (provider) => {
	const f = await mount();
	try {
		f.ctx.model.provider = provider;
		f.ctx.modelRegistry.isUsingOAuth = () => provider === "oauth";
		const stats = f.component.render(240)[1];
		if (provider === "api-key") expect(stats).not.toContain("cost ");
		else expect(stats).toContain("cost $0.000 (sub)");
	} finally {
		f.component.dispose?.();
	}
});

it("model thinking and provider labels adapt without overflow", async () => {
	const f = await mount();
	try {
		expect(f.component.render(240)[1]).toContain("(example-provider) example • high");
		f.ctx.thinkingLevel = "off";
		expect(f.component.render(240)[1]).toContain("example • thinking off");
		f.ctx.model.reasoning = false;
		expect(f.component.render(240)[1]).not.toContain("thinking");
		for (const width of [1, 10, 25, 60, 120, 240]) {
			for (const line of f.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	} finally {
		f.component.dispose?.();
	}
});
