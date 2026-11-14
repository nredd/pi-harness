/** Offline merge policy tests: actual disposable transcripts and recording child boundary, no GitHub. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command, executable, gitEvidence, main, merge, otherChecks, receipt } from "./merge-pr.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const sha = "a".repeat(40);
let root: string;
let env: NodeJS.ProcessEnv;
const argv = ["123", sha, "standards", "spec"];
const calls = vi.mocked(execFileSync);
const tool = (args: object = {}) => ({ type: "toolCall", name: "git_diff", arguments: args });
const report = (axis: string, head = sha) =>
	`Axis: ${axis}\nReviewed HEAD: ${head}\nChecked:\n- Exact diff\nFindings:\nNone.`;
function transcript(axis: string, content: object[] = [tool({ base: "main...HEAD" })], final = report(axis)): string {
	const path = join(root, "session", "tasks", `${axis.toLowerCase()}.output`);
	writeFileSync(
		path,
		[
			{ message: { role: "assistant", provider: "synthetic", model: "review", content } },
			{
				message: {
					role: "assistant",
					provider: "synthetic",
					model: "review",
					content: [{ type: "text", text: final }],
				},
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	return path;
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "merge-test-"));
	mkdirSync(join(root, "session", "tasks"), { recursive: true });
	const gh = join(root, "gh");
	writeFileSync(gh, "synthetic");
	chmodSync(gh, 0o700);
	env = { MERGE_PR_GH: gh, MERGE_PR_PYTHON: gh, MERGE_PR_TRANSCRIPT_ROOT: root };
	transcript("Standards");
	transcript("Spec");
	calls.mockReset();
	calls.mockImplementation((_exe, args) => (args?.includes("headRefOid") ? `${sha}\n` : ""));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("merge boundary", () => {
	it("posts receipt before pinned merge, cleans temporary body, includes history", () => {
		const history = join(root, "history");
		writeFileSync(history, "Local gate evidence");
		let bodyPath = "";
		calls.mockImplementation((_exe, args) => {
			if (args?.includes("headRefOid")) return sha;
			if (args?.includes("--body-file")) {
				bodyPath = String(args[args.length - 1]);
				expect(readFileSync(bodyPath, "utf8")).toContain("Local gate evidence");
			}
			return "ok";
		});
		expect(main([...argv, history], env)).toBe(0);
		expect(() => readFileSync(bodyPath)).toThrow();
		expect(calls.mock.calls.map((c) => c[1]?.slice(0, 2))).toEqual([
			["pr", "view"],
			[expect.stringContaining("merge_pr_checks.py"), "123"],
			["pr", "comment"],
			["pr", "merge"],
			["pr", "view"],
		]);
		expect(calls.mock.calls[3]?.[1]).toEqual([
			"pr",
			"merge",
			"123",
			"--repo",
			"nredd/pi-harness",
			"--merge",
			"--match-head-commit",
			sha,
		]);
	});
	it.each(
		[[], ["1", "bad", "s", "p"], ["1", sha, "s", "s"], ["1", sha, "!", "p"], ["1", sha, "s", "!"]].map((args) => ({
			args,
		})),
	)("refuses invalid argv $args", ({ args }) => {
		expect(main(args, env)).toBe(1);
		expect(calls).not.toHaveBeenCalled();
	});
	it.each([
		{ MERGE_PR_TRANSCRIPT_ROOT: undefined },
		{ MERGE_PR_TRANSCRIPT_ROOT: "relative" },
		{ MERGE_PR_TRANSCRIPT_ROOT: "/dev/null" },
		{ MERGE_PR_GH: "" },
		{ MERGE_PR_GH: undefined },
		{ MERGE_PR_PYTHON: undefined },
	])("refuses invalid environment %j", (patch) => {
		expect(main(argv, { ...env, ...patch })).toBe(1);
		expect(calls).not.toHaveBeenCalled();
	});
	it("refuses head drift before gate or mutation", () => {
		calls.mockReturnValue("wrong");
		expect(main(argv, env)).toBe(1);
		expect(calls).toHaveBeenCalledTimes(1);
	});
	it.each([1, 2, 3, 4])("stops at child failure %i", (failure) => {
		let index = 0;
		calls.mockImplementation((_exe, args) => {
			if (index++ === failure) throw new Error("refusal");
			return args?.includes("headRefOid") ? sha : "";
		});
		expect(main(argv, env)).toBe(1);
		expect(calls).toHaveBeenCalledTimes(failure + 1);
	});
	it("preserves empty repository default and ignores legacy trailing arguments", () => {
		merge([...argv, "", "", "legacy-extra"], env);
		expect(calls.mock.calls[1]?.[1]).toContain("nredd/pi-harness");
		expect(calls.mock.calls[1]?.[1]?.[0]).toEqual(expect.stringContaining("merge_pr_checks.py"));
	});
	it("preserves non-harness repositories", () => {
		merge([...argv, "", "example/project"], env);
		expect(calls.mock.calls[1]?.[1]).toContain("checks");
	});
	it("executes literal argv", () => {
		command("/synthetic", ["$(not-shell)"]);
		expect(calls).toHaveBeenCalledWith("/synthetic", ["$(not-shell)"], expect.objectContaining({ encoding: "utf8" }));
	});
	it("validates absolute regular executable, preserving symlinks", () => {
		expect(() => executable("relative")).toThrow();
		expect(() => executable(root)).toThrow();
		const link = join(root, "link");
		symlinkSync(env.MERGE_PR_GH as string, link);
		expect(executable(link)).toBe(link);
		chmodSync(link, 0o600);
		expect(() => executable(link)).toThrow();
	});
	it("rejects pending/failed other checks and discovery failure, accepts no-CI", () => {
		calls.mockReturnValue("PENDING synthetic");
		expect(() => otherChecks("/gh", "1", "r", sha)).toThrow("CI not green");
		calls.mockImplementation(() => {
			throw { stdout: "", stderr: "HTTP 403" };
		});
		expect(() => otherChecks("/gh", "1", "r", sha)).toThrow();
		calls.mockImplementation(() => {
			throw { stdout: "no checks reported", stderr: "" };
		});
		expect(() => otherChecks("/gh", "1", "r", sha)).not.toThrow();
	});
});

describe("transcripts", () => {
	it("requires unique regular transcript; malformed JSON fails closed", () => {
		expect(() => receipt(root, "missing", "Spec", sha)).toThrow("expected one");
		mkdirSync(join(root, "second", "tasks"), { recursive: true });
		writeFileSync(join(root, "second", "tasks", "spec.output"), "{}");
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow("got: 2");
		rmSync(join(root, "second"), { recursive: true });
		const path = join(root, "session", "tasks", "spec.output");
		rmSync(path);
		mkdirSync(path);
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow("not a file");
		rmSync(path, { recursive: true });
		writeFileSync(path, "not-json");
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow();
	});
	it.each([
		"",
		report("Standards"),
		report("Spec", "b".repeat(40)),
		`${report("Spec")}\nAxis: Spec`,
		`${report("Spec")}\nReviewed HEAD: ${sha}`,
		`Axis: Spec\nReviewed HEAD: ${sha}\nChecked: no\nFindings:\nNone.`,
		`Axis: Spec\nReviewed HEAD: ${sha}\nChecked:\n- diff\nFindings: None.`,
	])("refuses final report %j", (final) => {
		transcript("Spec", [], final);
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow("final report");
	});
	it("requires actual tool reads", () => {
		transcript("Spec", [], report("Spec"));
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow("no model");
	});
	it("deduplicates models/reads, records target variants, tolerates nonassistant rows", () => {
		const path = transcript("Spec", [
			tool({ base: "base" }),
			tool({ ref: "ref" }),
			tool({ rev: "rev" }),
			tool({ path: `${homedir()}/code/fixture`, pattern: "x".repeat(50) }),
			tool(),
			{ type: "toolCall", name: "read" },
			{ type: "other" },
		]);
		writeFileSync(
			path,
			`${readFileSync(path, "utf8")}\n{}\n${JSON.stringify({ message: { role: "user" } })}\n${JSON.stringify({ message: { role: "assistant" } })}`,
		);
		expect(receipt(root, "spec", "Spec", sha)).toContain(
			"`git_diff fixture /xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/`",
		);
	});
	it("uses the final nonempty assistant report", () => {
		const path = transcript("Spec");
		writeFileSync(
			path,
			`${readFileSync(path, "utf8")}\n${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: report("Spec", "b".repeat(40)) }] } })}`,
		);
		expect(() => receipt(root, "spec", "Spec", sha)).toThrow("final report");
	});
	it("runs actual CLI entry when loaded as entrypoint", async () => {
		const saved = process.argv;
		process.argv = [saved[0] as string, fileURLToPath(new URL("./merge-pr.ts", import.meta.url))];
		vi.resetModules();
		try {
			await import("./merge-pr.ts");
			expect(process.exitCode).toBe(1);
		} finally {
			process.argv = saved;
		}
	});
});

describe("Git evidence", () => {
	const base = {
		role: "toolResult",
		toolName: "git_diff",
		isError: false,
		content: [{ type: "text", text: "bad revision quoted in source" }],
	};
	it("does not reject quoted diagnostics or nonrevision failures", () => {
		gitEvidence(base as never);
		gitEvidence({ ...base, toolName: "read" } as never);
		gitEvidence({ ...base, toolName: undefined } as never);
		gitEvidence({ ...base, isError: true, content: [{ type: "text", text: "unrelated IO refusal" }] } as never);
	});
	it.each([
		{ isError: undefined },
		{ content: undefined },
		{ content: [null] },
		{ content: [{ type: "image" }] },
		{ content: [{ type: "text", text: 3 }] },
		{ isError: true },
		{ isError: true, content: [{ type: "text", text: " " }] },
	])("refuses invalid or unresolved Git evidence %j", (patch) => {
		expect(() => gitEvidence({ ...base, ...patch } as never)).toThrow();
	});
});
