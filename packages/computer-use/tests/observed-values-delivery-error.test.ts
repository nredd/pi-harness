// An observed field value never overrides an explicit delivery error (nredd/pi-harness#1198, same family as #1190).
import { expect, test } from "vitest";
import { outcomeAfterObservedValues } from "../src/actions.ts";
import { HelperCommandError } from "../src/platform/macos/helper.ts";
import { installFakeDesktop, wireNode } from "../test/support/fake-desktop.mjs";

const setText = { action: "setText" as const, ref: "@e2", text: "saved" };

/** The `installFakeDesktop` controls this file uses. */
interface FakeDesktop {
	tree: unknown[];
	actCalls: unknown[];
	actHook: () => Promise<never>;
	bridge: { executeAct: unknown };
	observe(): Promise<{ stateId: string }>;
	call(
		execute: unknown,
		params: object,
	): Promise<{ details: { execution: { outcome: string; error: { code: string } } } }>;
	text(result: unknown): string;
}

test("matching observed values promote only an error-free setText outcome", () => {
	const saved = () => "saved";
	expect(outcomeAfterObservedValues("didnt", [setText], saved, undefined)).toBe("worked");
	expect(outcomeAfterObservedValues("unknown", [setText], saved, undefined)).toBe("worked");
	for (const code of ["app_blocked", "input_deadline_expired", "postcondition_failed"])
		expect(outcomeAfterObservedValues("didnt", [setText], saved, { code })).toBe("didnt");
	expect(outcomeAfterObservedValues("unknown", [setText], saved, { code: "app_blocked" })).toBe("unknown");
});

test("a coded refusal after the cmd+a fallback stays didnt when the field already held the text", async ({
	onTestFinished,
}) => {
	const fake = (await installFakeDesktop(onTestFinished, { platform: "macos" })) as FakeDesktop;
	fake.tree = [wireNode("f1", "AXTextField", "Name", { value: "saved", actions: ["AXConfirm"] })];
	const { stateId } = await fake.observe();
	fake.actHook = async () => {
		throw new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked", { postedUnits: 1 });
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [setText] });
	const { execution } = result.details;
	expect(fake.actCalls).toHaveLength(1);
	expect(execution.error.code).toBe("app_blocked");
	expect(execution.outcome).toBe("didnt");
	expect(fake.text(result)).toMatch(/^Stopped at action 1 \(app_blocked\)\. 1 key pair posted\. Do not replay/);
});
