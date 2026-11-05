/** The heredoc delimiter retry, forced deterministically: random collisions never happen in practice. */
import { expect, it, vi } from "vitest";

const draws = vi.hoisted(() => ({ queue: [] as Buffer[] }));
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes: (size: number) => draws.queue.shift() ?? actual.randomBytes(size),
	};
});

const { remoteScript } = await import("../../src/ssh/exec.ts");

it("draws a new delimiter when the command already contains the candidate", () => {
	draws.queue.push(Buffer.alloc(6, 0xaa), Buffer.alloc(6, 0xbb));
	const script = remoteScript("echo __PI_CMD_aaaaaaaaaaaa");
	expect(draws.queue).toEqual([]);
	expect(script).toContain("<<'__PI_CMD_bbbbbbbbbbbb'");
	expect(script).not.toContain("<<'__PI_CMD_aaaaaaaaaaaa'");
	expect(script.split("\n")).toContain("__PI_CMD_bbbbbbbbbbbb");
});
