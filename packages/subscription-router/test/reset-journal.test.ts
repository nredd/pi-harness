import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptSchema, OutcomeSchema, ResetJournal } from "../src/reset-journal.js";
import { NOW } from "./fixtures/codex.js";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const binding = "a".repeat(64);
let root: string;
const path = (name: string) => join(root, "state", binding, name);
beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "codex-journal-test-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});
const journal = () => new ResetJournal(join(root, "state"), binding);
const put = (name: string, value: unknown) =>
	fs.writeFile(path(name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });

describe("private durable append-only reset journal", () => {
	it("ships a schema identical to the runtime-validated records", async () => {
		const schema = JSON.parse(
			await fs.readFile(new URL("../schemas/codex-reset-journal.schema.json", import.meta.url), "utf8"),
		);
		expect(schema.oneOf).toEqual(JSON.parse(JSON.stringify([AttemptSchema, OutcomeSchema])));
	});
	it("serializes fresh attempts across independent owners and preserves keys across reload", async () => {
		const results = await Promise.allSettled([
			journal().claim("grant", NOW, NOW + 1000),
			journal().claim("grant", NOW, NOW + 1000),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const attempt = (await journal().entries())[0]?.attempt;
		expect(attempt?.key).toMatch(/^[a-f0-9-]{36}$/);
		await expect(journal().claim("other", NOW, NOW + 1000)).rejects.toThrow("unresolved");
		expect((await fs.stat(path("attempt-1.json"))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(join(root, "state"))).mode & 0o777).toBe(0o700);
		if (!attempt) throw new Error("missing attempt");
		await journal().settle(attempt, "reset");
		await journal().settle(attempt, "reset");
		await journal().settle(attempt, "alreadyRedeemed");
		await expect(journal().claim("grant", NOW, NOW + 1000)).rejects.toThrow("already-used");
		const next = await journal().claim("other", NOW, NOW + 1000);
		expect(next.sequence).toBe(2);
		await journal().settle(next, "nothingToReset");
		expect(await journal().entries()).toHaveLength(2);
		await expect(journal().claim("other", NOW, NOW + 1000)).rejects.toThrow("unresolved");
		await journal().settle(next, "noCredit");
		await journal().settle(next, "notDispatched");
		expect((await journal().entries())[1]?.outcome).toBeUndefined();
		await journal().settle(next, "alreadyRedeemed");
		await expect(journal().claim("other", NOW, NOW + 1000)).rejects.toThrow("already-used");
		await journal().settle(next, "noCredit");
		expect((await journal().entries())[1]?.outcome).toBe("alreadyRedeemed");
		await expect(journal().settle(next, "reset")).resolves.toBeUndefined();
	});
	it.each(["notDispatched", "noCredit", "nothingToReset"])(
		"retains legacy %s barriers and rejects unsafe suffixes",
		async (outcome) => {
			const attempt = await journal().claim("grant", NOW, NOW + 1000);
			await put("outcome-1.json", { version: 1, key: attempt.key, outcome });
			expect((await journal().entries())[0]?.outcome).toBeUndefined();
			await expect(journal().claim("other", NOW, NOW + 1000)).rejects.toThrow("unresolved");
			await expect(journal().settle(attempt, "reset")).rejects.toThrow("Conflicting");
			await put("attempt-2.json", { ...attempt, sequence: 2 });
			await expect(journal().entries()).rejects.toThrow("inconsistent");
		},
	);
	it("fails closed for invalid binding, insecure directories and symlink state", async () => {
		expect(() => new ResetJournal(root, "../outside")).toThrow("Invalid");
		expect(() => new ResetJournal(root, "../outside", binding)).toThrow("Invalid");
		await fs.mkdir(join(root, "state"), { mode: 0o755 });
		await expect(journal().entries()).rejects.toThrow("private");
		await fs.chmod(join(root, "state"), 0o700);
		await fs.symlink(root, join(root, "state", binding));
		await expect(journal().entries()).rejects.toThrow("private");
	});
	it.each([
		"bad-json",
		"public",
		"large",
		"directory",
		"symlink",
		"schema",
		"sequence",
		"scope",
		"orphan",
		"unknown-name",
		"gap",
		"unsettled-prefix",
		"result-key",
		"result-schema",
	])("rejects %s records without assuming no dispatch", async (mode) => {
		const attempt = await journal().claim("grant", NOW, NOW + 1000);
		if (mode === "bad-json") await put("attempt-1.json", "{");
		if (mode === "public") await fs.chmod(path("attempt-1.json"), 0o644);
		if (mode === "large") await put("attempt-1.json", "x".repeat(8193));
		if (mode === "directory" || mode === "symlink") {
			await fs.unlink(path("attempt-1.json"));
			if (mode === "directory") await fs.mkdir(path("attempt-1.json"));
			else await fs.symlink(join(root, "outside"), path("attempt-1.json"));
		}
		if (mode === "schema") await put("attempt-1.json", {});
		if (mode === "sequence") await put("attempt-1.json", { ...attempt, sequence: 2 });
		if (mode === "scope") await put("attempt-1.json", { ...attempt, scope: "b".repeat(64) });
		if (mode === "orphan") await put("outcome-2.json", { version: 1, key: attempt.key, outcome: "reset" });
		if (mode === "unknown-name") await put("unexpected", "{}");
		if (mode === "gap") await fs.rename(path("attempt-1.json"), path("attempt-2.json"));
		if (mode === "unsettled-prefix") await put("attempt-2.json", { ...attempt, sequence: 2 });
		if (mode === "result-key") await put("outcome-1.json", { version: 1, key: "b".repeat(36), outcome: "reset" });
		if (mode === "result-schema") await put("outcome-1.json", {});
		await expect(journal().entries()).rejects.toThrow();
	});
	it("does not publish malformed claims/receipts or overwrite a mismatched receipt", async () => {
		await expect(journal().claim("", NOW, NOW)).rejects.toThrow("validated");
		const attempt = await journal().claim("grant", NOW, NOW + 1000);
		await expect(journal().settle({ ...attempt, binding: "b".repeat(64) }, "reset")).rejects.toThrow("Invalid");
		await expect(journal().settle({ ...attempt, scope: "b".repeat(64) }, "reset")).rejects.toThrow("Invalid");
		await expect(journal().settle(attempt, "bad" as never)).rejects.toThrow("Invalid");
		await put("outcome-1.json", {});
		await expect(journal().settle(attempt, "reset")).rejects.toThrow("Conflicting");
		await put("outcome-1.json", { version: 1, key: "b".repeat(36), outcome: "reset" });
		await expect(journal().settle(attempt, "reset")).rejects.toThrow("Conflicting");
	});
	it("cleans temporary files and propagates publication I/O failure before dispatch", async () => {
		await journal().entries();
		vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("synthetic I/O"), { code: "EIO" }));
		await expect(journal().claim("grant", NOW, NOW)).rejects.toThrow("synthetic I/O");
		expect(await fs.readdir(join(root, "state", binding))).toEqual([]);
	});
});
