import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withLock } from "../../src/core/index.ts";
import { findProjectRoot, registerPyTools } from "../../src/py/index.ts";
import { createMockPi } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

const fixtures: ReturnType<typeof wrapperFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function setup() {
	const fixture = wrapperFixture("pyproject.toml");
	fixtures.push(fixture);
	const mock = createMockPi();
	registerPyTools(mock.pi, { uvBin: fixture.bin });
	return { ...fixture, ...mock };
}

describe("uv executable boundary", () => {
	it("reports unknown output, tool errors, and mixed parsed/unparsed findings", async () => {
		const f = setup();
		f.script('console.log("future diagnostic format"); process.exit(1);');
		const unknown = await f.call("py_lint", {}, f.root);
		expect(unknown.structuredContent).toMatchObject({
			state: "unparsed",
			count: 0,
			unparsed: ["future diagnostic format"],
		});
		expect(unknown.isError).toBe(true);
		f.script('console.log("a.py:1:2: F401 unused import"); console.log("future extra"); process.exit(1);');
		const mixed = await f.call("py_lint", {}, f.root);
		expect(mixed.structuredContent).toMatchObject({ state: "findings", count: 1, unparsed: ["future extra"] });
		expect(f.text(mixed)).toContain("unparsed output (1 lines)");
		f.script('console.error("tool invocation rejected"); process.exit(2);');
		for (const name of ["py_lint", "py_format"]) {
			const result = await f.call(name, {}, f.root);
			expect(result.isError).toBe(true);
			expect(f.text(result)).toContain("tool error (exit 2)");
		}
	});

	it("rejects drifted apply summaries and keeps failed uv management output", async () => {
		const f = setup();
		f.script('console.log("future format summary");');
		const format = await f.call("py_format", { mode: "apply" }, f.root);
		expect(format.isError).toBe(true);
		expect(f.text(format)).toContain("could not read the summary line");
		f.script('console.error("dependency resolution failed"); process.exit(2);');
		const result = await f.call("py_uv", { action: "sync" }, f.root);
		expect(result.isError).toBe(true);
		expect(f.text(result)).toContain("uv sync: exit 2\ndependency resolution failed");
	});

	it("preserves an unchanged apply result and passes dependency groups as separate argv", async () => {
		const f = setup();
		f.script('console.log("1 file left unchanged");');
		const unchanged = await f.call("py_format", { mode: "apply" }, f.root);
		expect(unchanged.structuredContent).toEqual({ state: "clean", files: [], reformatted: 0 });
		f.script('console.log("Added " + JSON.stringify(process.argv.slice(2)));');
		for (const action of ["add", "remove"]) {
			const result = await f.call("py_uv", { action, packages: ["fixture>=1"], group: "test", dev: true }, f.root);
			expect(result.isError).toBe(false);
			expect(result.structuredContent).toMatchObject({
				action,
				state: "ok",
				summary: `Added ${JSON.stringify([action, "--dev", "--group", "test", "--", "fixture>=1"])}`,
			});
		}
	});

	it("maps unexpected pytest exits instead of claiming test failure", async () => {
		const f = setup();
		f.script('console.error("internal plugin problem"); process.exit(3);');
		const result = await f.call("py_test", {}, f.root);
		expect(result.isError).toBe(true);
		expect(f.text(result)).toContain("pytest: unexpected exit 3");
		expect(f.text(result)).toContain("internal plugin problem");
		expect(findProjectRoot("/does-not-exist/dev-tools-fixture")).toBeUndefined();
	});

	it("maps signal exits for every uv wrapper", async () => {
		const f = setup();
		f.script('process.kill(process.pid, "SIGTERM");');
		for (const name of ["py_lint", "py_format", "py_typecheck", "py_test", "py_uv"]) {
			const result = await f.call(name, name === "py_uv" ? { action: "sync" } : {}, f.root);
			expect(result.isError).toBe(true);
			expect(f.text(result)).toContain("SIGTERM");
		}
	});

	it("cancels a queued uv call and publishes waiting feedback", async () => {
		const f = setup();
		f.script('require("node:fs").writeFileSync("started", "wrong"); throw new Error("must not start");');
		const controller = new AbortController();
		const updates: unknown[] = [];
		await withLock(`uv:${f.root}`, async () => {
			const pending = f.tools
				.get("py_lint")
				?.execute("id", {}, controller.signal, ((value: unknown) => updates.push(value)) as never, { cwd: f.root });
			controller.abort();
			expect(await pending).toMatchObject({ isError: true });
		});
		expect(JSON.stringify(updates)).toContain("waiting for another uv run");
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});
});
