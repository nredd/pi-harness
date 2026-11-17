import { expect, test } from "vitest";
import { deferred } from "../src/deferred.ts";

test("resolves with the released value", async () => {
	const gate = deferred<number>();
	gate.resolve(3);
	await expect(gate.promise).resolves.toBe(3);
});

test("a void gate releases with no argument", async () => {
	const gate = deferred();
	let released = false;
	void gate.promise.then(() => {
		released = true;
	});
	await Promise.resolve();
	expect(released).toBe(false);
	gate.resolve();
	await gate.promise;
	expect(released).toBe(true);
});
