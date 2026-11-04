import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MockInstance, test, vi } from "vitest";
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
	for (const value of [null, secret, [], {}, { type: secret }]) trace.raw(value);
	assert.deepEqual(records, []);
	assert.deepEqual(blockTypes(secret), { blocks: [], truncated: false });
	assert.deepEqual(blockTypes([null]), {
		blocks: ["unknown"],
		truncated: false,
	});
	assert.equal(blockTypes(Array.from({ length: 1000 }, () => ({ type: "text", text: secret }))).blocks?.length, 128);
	assert.equal(blockTypes(Array(1000).fill(null)).truncated, true);
});

type Handler = (event: never, ctx: never) => unknown;

/** Register the extension against a recording API and a private trace directory. */
function harness(prefix: string, sessionManager?: unknown) {
	const previous = process.env.PI_TRANSCRIPT_TYPES_DIR;
	const root = mkdtempSync(join(tmpdir(), prefix));
	const directory = join(root, "trace");
	const handlers = new Map<string, Handler>();
	const api = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const notices: string[] = [];
	const ctx = { ui: { notify: (message: string) => notices.push(message) }, sessionManager };
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
	const register = (enabled = true) => {
		if (enabled) process.env.PI_TRANSCRIPT_TYPES_DIR = directory;
		else delete process.env.PI_TRANSCRIPT_TYPES_DIR;
		transcriptTypes(api);
	};
	const cleanup = () => {
		emit("session_shutdown");
		if (previous === undefined) delete process.env.PI_TRANSCRIPT_TYPES_DIR;
		else process.env.PI_TRANSCRIPT_TYPES_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	};
	return { root, directory, handlers, notices, emit, register, cleanup };
}

/** The only trace file in `directory`. */
function onlyFile(directory: string): string {
	const files = readdirSync(directory);
	assert.equal(files.length, 1);
	const [name] = files;
	assert.ok(name);
	return join(directory, name);
}

/** An assistant message whose 128 thinking blocks project to one ~840-byte record. */
const wideMessage = {
	role: "assistant",
	api: "anthropic-messages",
	content: Array.from({ length: 128 }, () => ({ type: "thinking", thinking: secret })),
};

test("extension is inert without opt-in; opt-in writes private bounded metadata and closes on shutdown", () => {
	const h = harness("pi-type-probe-test-", {
		getLeafId: () => "before",
		getBranch: () => [
			{
				id: "after",
				type: "message",
				message: { role: "assistant", api: "anthropic-messages", content: [{ type: "text", text: secret }] },
			},
		],
	});
	try {
		h.register(false);
		assert.equal(h.handlers.size, 0);
		h.register();
		assert.deepEqual(readdirSync(h.root), []); // Registration does no filesystem work.
		h.emit("session_start");
		h.emit("provider_stream_event", { api: "anthropic-messages", data: { type: "message_start" } });
		h.emit("provider_stream_event", {
			api: "anthropic-messages",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: secret } },
		});
		const message = { role: "assistant", api: "anthropic-messages", content: [{ type: "text", text: secret }] };
		h.emit("message_update", { message });
		h.emit("message_update", { message });
		h.emit("message_end", { message });
		h.emit("agent_settled");
		h.emit("agent_settled");
		h.emit("session_shutdown");
		const file = onlyFile(h.directory);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const content = readFileSync(file, "utf8");
		assert.equal(content.includes(secret), false);
		assert.deepEqual(
			content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).stage),
			["start", "raw_start", "raw_block", "normalized", "message_end", "session"],
		);
		h.emit("message_end", { message });
		assert.equal(readFileSync(file, "utf8"), content);
		assert.deepEqual(h.notices, []);
	} finally {
		h.cleanup();
	}
});

for (const failure of ["size-limit", "open-error", "close-error"]) {
	test(`capture safely stops on ${failure}`, () => {
		const h = harness("pi-type-probe-failure-");
		const originalClose = fs.closeSync;
		const closeMock =
			failure === "close-error"
				? vi.spyOn(fs, "closeSync").mockImplementation((fd: number) => {
						originalClose(fd);
						throw new Error(secret);
					})
				: undefined;
		syncBuiltinESMExports();
		try {
			if (failure === "open-error") writeFileSync(h.directory, "do not overwrite");
			h.register();
			h.emit("session_start");
			for (let i = 0; i < (failure === "close-error" ? 1 : 2500); i++) h.emit("message_end", { message: wideMessage });
			assert.doesNotThrow(() => h.emit("session_shutdown"));
			closeMock?.mockRestore();
			syncBuiltinESMExports();
			assert.equal(h.notices.length, 1);
			const [notice] = h.notices;
			assert.ok(notice);
			assert.equal(notice.includes(secret), false);
			if (failure === "open-error") {
				assert.equal(readFileSync(h.directory, "utf8"), "do not overwrite");
				assert.match(notice, /could not start/);
			} else if (failure === "close-error") {
				assert.match(notice, /close failure/);
			} else {
				const file = onlyFile(h.directory);
				assert.ok(statSync(file).size <= 2 * 1024 * 1024 + 30);
				const content = readFileSync(file, "utf8");
				assert.equal(content.includes(secret), false);
				assert.match(content, /"stage":"capture_limit"/);
				assert.match(notice, /2 MiB limit/);
			}
		} finally {
			closeMock?.mockRestore();
			syncBuiltinESMExports();
			h.cleanup();
		}
	});
}

test("block indices past the cap record one truncation marker per raw message", () => {
	const records: unknown[] = [];
	const trace = new TypeTrace((record) => records.push(record));
	const overflow = { type: "content_block_start", index: 128, content_block: { type: "text", text: secret } };
	trace.raw({ type: "message_start" });
	trace.raw(overflow);
	trace.raw({ ...overflow, index: 129 });
	trace.raw({ type: "message_start" });
	trace.raw(overflow);
	assert.equal(JSON.stringify(records).includes(secret), false);
	assert.deepEqual(records, [
		{ stage: "raw_start", request: 1 },
		{ stage: "raw_block", request: 1, truncated: true },
		{ stage: "raw_start", request: 2 },
		{ stage: "raw_block", request: 2, truncated: true },
	]);
});

for (const failure of ["write-error", "restart-close-error"]) {
	test(`capture safely stops on ${failure} after a successful start`, () => {
		const h = harness("pi-type-probe-started-");
		const message = { role: "assistant", api: "anthropic-messages", content: [{ type: "text", text: secret }] };
		const originalClose = fs.closeSync;
		let fsMock: MockInstance | undefined;
		try {
			h.register();
			h.emit("session_start");
			assert.equal(h.notices.length, 0);
			const file = onlyFile(h.directory);
			const started = readFileSync(file, "utf8");
			assert.match(started, /"stage":"start"/);
			fsMock =
				failure === "write-error"
					? vi.spyOn(fs, "writeSync").mockImplementation(() => {
							throw new Error(secret);
						})
					: vi.spyOn(fs, "closeSync").mockImplementation((fd: number) => {
							originalClose(fd);
							throw new Error(secret);
						});
			syncBuiltinESMExports();
			if (failure === "write-error") h.emit("message_end", { message });
			else h.emit("session_start");
			// Vitest's `mockRestore` also clears the recorded calls, so count them first.
			assert.ok(fsMock.mock.calls.length >= 1);
			fsMock.mockRestore();
			syncBuiltinESMExports();
			assert.equal(h.notices.length, 1);
			const [notice] = h.notices;
			assert.ok(notice);
			assert.equal(notice.includes(secret), false);
			assert.match(notice, failure === "write-error" ? /I\/O failure/ : /close failure/);
			// Capture is closed: later events neither write nor reopen a trace.
			h.emit("message_end", { message });
			assert.equal(onlyFile(h.directory), file);
			assert.equal(readFileSync(file, "utf8"), started);
		} finally {
			fsMock?.mockRestore();
			syncBuiltinESMExports();
			h.cleanup();
		}
	});
}

test("a restarted session gets a fresh byte budget and a fresh file", () => {
	const h = harness("pi-type-probe-restart-");
	// ~1.1 MiB per session: under the 2 MiB cap alone, over it if the first session's bytes carried over.
	const records = 1300;
	try {
		h.register();
		h.emit("session_start");
		for (let i = 0; i < records; i++) h.emit("message_end", { message: wideMessage });
		// A streamed update left pending at restart must not suppress the same shape in the next session.
		h.emit("message_update", { message: wideMessage });
		const first = onlyFile(h.directory);
		const firstSize = statSync(first).size;
		assert.ok(firstSize > 1024 * 1024 && firstSize < 2 * 1024 * 1024, `first session wrote ${firstSize} bytes`);
		h.emit("session_start");
		h.emit("message_update", { message: wideMessage });
		for (let i = 0; i < records; i++) h.emit("message_end", { message: wideMessage });
		h.emit("session_shutdown");
		assert.deepEqual(h.notices, []);
		assert.equal(statSync(first).size, firstSize);
		const files = readdirSync(h.directory).map((name) => join(h.directory, name));
		assert.equal(files.length, 2);
		const second = files.find((file) => file !== first);
		assert.ok(second);
		const content = readFileSync(second, "utf8");
		assert.doesNotMatch(content, /capture_limit/);
		const stages = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).stage);
		assert.deepEqual(stages.slice(0, 2), ["start", "normalized"]);
		assert.equal(stages.length, records + 2);
	} finally {
		h.cleanup();
	}
});
