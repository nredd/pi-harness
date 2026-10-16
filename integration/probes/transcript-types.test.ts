import assert from "node:assert/strict";
import fs, {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import transcriptTypes, { blockTypes, TypeTrace } from "./transcript-types.ts";

const secret = "DO-NOT-LOG-private-text-signature-token";

test("projection records types, never content, signatures, names, or unexpected labels", () => {
	const records: unknown[] = [];
	const trace = new TypeTrace((record) => records.push(record));
	const events = [
		{ type: "message_start", message: { id: secret } },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: secret, signature: secret },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: secret },
		},
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: secret },
		},
		{
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: secret },
		},
		{
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", name: secret, input: { secret } },
		},
		{
			type: "content_block_delta",
			index: 2,
			delta: { type: secret, text: secret },
		},
		{ type: "message_stop" },
	];
	const original = structuredClone(events);
	for (const event of events) trace.raw(event);
	trace.message("message_end", [
		{ type: "thinking", thinking: secret },
		{ type: "text", text: secret },
		{ type: secret },
	]);
	assert.deepEqual(events, original);
	assert.equal(JSON.stringify(records).includes(secret), false);
	assert.deepEqual(records.at(-1), {
		stage: "message_end",
		request: 1,
		blocks: ["thinking", "text", "unknown"],
		truncated: false,
	});
});

test("delta recording is deduplicated and reset at each raw message", () => {
	const records: unknown[] = [];
	const trace = new TypeTrace((record) => records.push(record));
	const delta = {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: secret },
	};
	trace.raw({ type: "message_start" });
	for (let i = 0; i < 10000; i++) trace.raw(delta);
	trace.raw({ type: "message_start" });
	trace.raw(delta);
	assert.equal(records.length, 4);
	assert.deepEqual(records.at(-1), {
		stage: "raw_delta",
		request: 2,
		index: 0,
		block: "text_delta",
	});
});

test("invalid provider indices and structures cannot escape the projector", () => {
	const records: unknown[] = [];
	const trace = new TypeTrace((record) => records.push(record));
	for (const index of [-1, 0.5, Infinity, NaN, secret, null]) {
		trace.raw({
			type: "content_block_start",
			index,
			content_block: { type: secret },
		});
	}
	for (const value of [null, secret, [], {}, { type: secret }])
		trace.raw(value);
	assert.deepEqual(records, []);
	assert.deepEqual(blockTypes(secret), { blocks: [], truncated: false });
	assert.deepEqual(blockTypes([null]), {
		blocks: ["unknown"],
		truncated: false,
	});
	assert.equal(
		blockTypes(
			Array.from({ length: 1000 }, () => ({ type: "text", text: secret })),
		).blocks?.length,
		128,
	);
	assert.equal(blockTypes(Array(1000).fill(null)).truncated, true);
});

test("extension is inert without opt-in; opt-in writes private bounded metadata and closes on shutdown", () => {
	const previous = process.env.PI_TRANSCRIPT_TYPES_DIR;
	const root = mkdtempSync(join(tmpdir(), "pi-type-probe-test-"));
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const api = {
		on: (name: string, handler: (event: never, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
	};
	const notices: string[] = [];
	const ctx = {
		ui: { notify: (message: string) => notices.push(message) },
		sessionManager: {
			getLeafId: () => "before",
			getBranch: () => [
				{
					id: "after",
					type: "message",
					message: {
						role: "assistant",
						api: "anthropic-messages",
						content: [{ type: "text", text: secret }],
					},
				},
			],
		},
	};
	const emit = (name: string, event: unknown = {}) =>
		handlers.get(name)?.(event as never, ctx as never);
	try {
		delete process.env.PI_TRANSCRIPT_TYPES_DIR;
		transcriptTypes(api as unknown as ExtensionAPI);
		assert.equal(handlers.size, 0);
		process.env.PI_TRANSCRIPT_TYPES_DIR = join(root, "trace");
		transcriptTypes(api as unknown as ExtensionAPI);
		assert.deepEqual(readdirSync(root), []); // Registration does no filesystem work.
		emit("session_start");
		emit("provider_stream_event", {
			api: "anthropic-messages",
			data: { type: "message_start" },
		});
		emit("provider_stream_event", {
			api: "anthropic-messages",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: secret },
			},
		});
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			content: [{ type: "text", text: secret }],
		};
		emit("message_update", { message });
		emit("message_update", { message });
		emit("message_end", { message });
		emit("agent_settled");
		emit("agent_settled");
		emit("session_shutdown");
		const files = readdirSync(join(root, "trace"));
		assert.equal(files.length, 1);
		const file = join(root, "trace", files[0]);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const content = readFileSync(file, "utf8");
		assert.equal(content.includes(secret), false);
		assert.deepEqual(
			content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).stage),
			[
				"start",
				"raw_start",
				"raw_block",
				"normalized",
				"message_end",
				"session",
			],
		);
		emit("message_end", { message });
		assert.equal(readFileSync(file, "utf8"), content);
		assert.deepEqual(notices, []);
	} finally {
		emit("session_shutdown");
		if (previous === undefined) delete process.env.PI_TRANSCRIPT_TYPES_DIR;
		else process.env.PI_TRANSCRIPT_TYPES_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

for (const failure of ["size-limit", "open-error", "close-error"]) {
	test(`capture safely stops on ${failure}`, () => {
		const previous = process.env.PI_TRANSCRIPT_TYPES_DIR;
		const root = mkdtempSync(join(tmpdir(), "pi-type-probe-failure-"));
		const handlers = new Map<string, (event: never, ctx: never) => unknown>();
		const api = {
			on: (name: string, handler: (event: never, ctx: never) => unknown) => {
				handlers.set(name, handler);
			},
		};
		const notices: string[] = [];
		const ctx = { ui: { notify: (message: string) => notices.push(message) } };
		const emit = (name: string, event: unknown = {}) =>
			handlers.get(name)?.(event as never, ctx as never);
		const directory = join(root, "trace");
		const originalClose = fs.closeSync;
		const closeMock =
			failure === "close-error"
				? mock.method(fs, "closeSync", (fd: number) => {
						originalClose(fd);
						throw new Error(secret);
					})
				: undefined;
		syncBuiltinESMExports();
		try {
			if (failure === "open-error")
				writeFileSync(directory, "do not overwrite");
			process.env.PI_TRANSCRIPT_TYPES_DIR = directory;
			transcriptTypes(api as unknown as ExtensionAPI);
			emit("session_start");
			const message = {
				role: "assistant",
				api: "anthropic-messages",
				content: Array.from({ length: 128 }, () => ({
					type: "thinking",
					thinking: secret,
				})),
			};
			for (let i = 0; i < (failure === "close-error" ? 1 : 2500); i++)
				emit("message_end", { message });
			assert.doesNotThrow(() => emit("session_shutdown"));
			closeMock?.mock.restore();
			syncBuiltinESMExports();
			assert.equal(notices.length, 1);
			assert.equal(notices.join().includes(secret), false);
			if (failure === "open-error") {
				assert.equal(readFileSync(directory, "utf8"), "do not overwrite");
				assert.match(notices[0], /could not start/);
			} else if (failure === "close-error") {
				assert.match(notices[0], /close failure/);
			} else {
				const file = join(directory, readdirSync(directory)[0]);
				assert.ok(statSync(file).size <= 2 * 1024 * 1024 + 30);
				const content = readFileSync(file, "utf8");
				assert.equal(content.includes(secret), false);
				assert.match(content, /"stage":"capture_limit"/);
				assert.match(notices[0], /2 MiB limit/);
			}
		} finally {
			closeMock?.mock.restore();
			syncBuiltinESMExports();
			emit("session_shutdown");
			if (previous === undefined) delete process.env.PI_TRANSCRIPT_TYPES_DIR;
			else process.env.PI_TRANSCRIPT_TYPES_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
}
