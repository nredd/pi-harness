/** Historical transcript snapshots through the real resource loader, renderer cache and resize. */
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vitest";
import { TodoFixture, todo, turn } from "./todo-support.ts";

it("core reload and resize retain historical row subjects", async () => {
	const fixture = await TodoFixture.create();
	const records: { args: unknown; subject: string | undefined; rendered: string; probe: boolean }[] = [];
	let loads = 0;
	try {
		const host = await fixture.start(140, 60, (pi) => {
			loads++;
			pi.registerToolRenderer((name, next) => {
				const renderers = next();
				if (name !== "todo" || !renderers?.renderCall) return renderers;
				const renderCall = renderers.renderCall;
				return {
					...renderers,
					renderCall(args, theme, context) {
						const component = renderCall(args, theme, context);
						const state = context.state as { taskSnapshot?: { tasks: { id: number; subject: string }[] } };
						if (component && state.taskSnapshot) {
							records.push({
								args: structuredClone(args),
								subject: state.taskSnapshot.tasks.find((task) => task.id === 1)?.subject,
								rendered: stripVTControlCharacters(component.render(200).join("\n")),
								probe: context.probe === true,
							});
						}
						return component;
					},
				};
			});
		});
		await turn(host, [
			todo({ action: "create", subject: "historical subject" }),
			todo({ action: "update", id: 1, status: "in_progress" }),
			todo({ action: "update", id: 1, subject: "today's subject" }),
		]);
		const file = host.harness.sessionManager.getSessionFile();
		if (!file) throw new Error("History scenario requires a persisted session");
		expect(readFileSync(file, "utf8")).toContain("historical subject");
		expect(readFileSync(file, "utf8")).toContain("today's subject");
		const session = host.harness.session;
		const reload = vi.spyOn(session.resourceLoader, "reload");
		records.length = 0;
		host.input("/reload");
		host.input("\r");
		await host.settle();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(loads).toBe(2);
		expect(host.harness.session).toBe(session);
		expect(host.harness.sessionManager.getSessionFile()).toBe(file);
		expect(host.viewport().join("\n")).toContain("todo → historical subject");
		expect(records.length).toBeGreaterThan(0);

		host.resize(100, 60);
		await host.settle();
		expect(host.viewport().join("\n")).toContain("todo → historical subject · ◐ in progress");
		expect(host.terminal.columns).toBe(100);
		const historical = records.filter((record) => {
			const args = record.args as { action?: string; id?: number; status?: string };
			return args.action === "update" && args.id === 1 && args.status === "in_progress" && !record.probe;
		});
		expect(historical.length).toBeGreaterThan(0);
		expect(historical.at(-1)?.subject).toBe("historical subject");
		expect(historical.at(-1)?.rendered).toContain("historical subject");
		expect(historical.at(-1)?.rendered).not.toContain("today's subject");
	} finally {
		vi.restoreAllMocks();
		await fixture.dispose();
	}
});
