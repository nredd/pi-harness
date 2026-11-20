const DEFAULT_LIMITS = Object.freeze({
	messageBytes: 2 * 1024,
	pairPerMinute: 4,
	senderPerMinute: 12,
	pendingPerRecipient: 32,
	rootMessages: 100,
	rootBytes: 128 * 1024,
});
const MINUTE_MS = 60_000;
const TOKEN_LENGTH = 128;
const MUTE_LIMIT = 100;

type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

interface RunAddress {
	readonly id: string;
	readonly run: string;
}

interface Scope {
	readonly root: string;
	readonly user: string;
	readonly process: string;
}

interface LiveRun extends RunAddress, Scope {
	readonly status: "queued" | "running" | "finished" | "error";
}

interface MailboxOptions {
	scope: Scope;
	/** Trusted, synchronous lookups; these callbacks must not mutate the mailbox. */
	resolve: (id: string) => LiveRun | undefined;
	allows: (phase: "send" | "delivery", from: LiveRun, to: LiveRun) => boolean;
	limits?: Partial<Limits>;
	/** Monotonic milliseconds. No timers are scheduled by the mailbox. */
	now?: () => number;
}

type State = "accepted" | "delivered" | "rejected" | "cancelled" | "expired";
type Rejection =
	| "stale-sender"
	| "invalid-address"
	| "invalid-key"
	| "retry-conflict"
	| "self"
	| "stale-recipient"
	| "disabled"
	| "muted"
	| "policy"
	| "message-bytes"
	| "pair-rate"
	| "sender-rate"
	| "recipient-capacity"
	| "root-messages"
	| "root-bytes";
type SendResult = { id: number; state: State } | { state: "rejected"; reason: Rejection };

interface MailboxMessage {
	readonly id: number;
	readonly kind: "untrusted-peer-data";
	readonly from: RunAddress;
	readonly to: RunAddress;
	readonly payload: string;
	readonly bytes: number;
	readonly acceptedAt: number;
	readonly state: State;
}

type Entry = Omit<MailboxMessage, "state"> & { state: State; key: string };

function token(value: string): boolean {
	return value.length > 0 && value.length <= TOKEN_LENGTH;
}

function address({ id, run }: RunAddress): RunAddress {
	return { id, run };
}

function sameRun(a: RunAddress, b: RunAddress): boolean {
	return a.id === b.id && a.run === b.run;
}

function reject(reason: Rejection): SendResult {
	return { state: "rejected", reason };
}

function limitsWith(overrides: Partial<Limits> | undefined): Limits {
	const limits: Limits = { ...DEFAULT_LIMITS };
	for (const name of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
		const limit = overrides?.[name];
		if (limit === undefined) continue;
		if (!Number.isInteger(limit) || limit < 0 || limit > DEFAULT_LIMITS[name]) {
			throw new RangeError(`Invalid mailbox limit: ${name}`);
		}
		limits[name] = limit;
	}
	return limits;
}

/** One in-memory journal per root session. Parent-owned; never expose the store to a child. */
export class PeerMailbox {
	private readonly scope: Scope;
	private readonly resolve: MailboxOptions["resolve"];
	private readonly allows: MailboxOptions["allows"];
	private readonly now: () => number;
	private readonly limits: Limits;
	private readonly entries: Entry[] = [];
	private readonly mutes = new Set<string>();
	private bytes = 0;
	private enabled = false;

	constructor({ scope, resolve, allows, limits, now = () => performance.now() }: MailboxOptions) {
		if (!token(scope.root) || !token(scope.user) || !token(scope.process)) {
			throw new TypeError("Mailbox requires a root, user and process identity");
		}
		this.scope = { ...scope };
		this.resolve = resolve;
		this.allows = allows;
		this.limits = limitsWith(limits);
		this.now = now;
	}

	/** Bind the sender from trusted run state, never from a send request. */
	bind(sender: RunAddress): (to: RunAddress, key: string, payload: string) => SendResult {
		const from = address(sender);
		return (to, key, payload) => this.send(from, address(to), key, payload);
	}

	/** Parent audit snapshots, including terminal payloads, in acceptance order. */
	inspect(): MailboxMessage[] {
		return this.entries.map(({ key: _key, ...message }) => ({
			...message,
			from: address(message.from),
			to: address(message.to),
		}));
	}

	/** Disabling drops pending messages; re-enabling never resurrects them. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.cancelWhere(() => true);
	}

	/** Mutes persist across runs of the same agent ID for the life of this root. */
	setAgentMuted(id: string, muted: boolean): void {
		this.setMute([id], muted, ({ from, to }) => from.id === id || to.id === id);
	}

	setPairMuted(fromId: string, toId: string, muted: boolean): void {
		this.setMute([fromId, toId], muted, ({ from, to }) => from.id === fromId && to.id === toId);
	}

	/** Explicit terminal transitions; expiry is decided by the caller, not a timer. */
	discard(id: number, state: "cancelled" | "expired" | "rejected"): boolean {
		const entry = this.entries[id - 1];
		if (entry?.state !== "accepted") return false;
		entry.state = state;
		return true;
	}

	/** Record a consumption decision only. This does not read into a session, enqueue or wake anything. */
	markDelivered(id: number): boolean {
		const entry = this.entries[id - 1];
		if (entry?.state !== "accepted") return false;
		const first = this.entries.find((pending) => pending.state === "accepted" && sameRun(pending.to, entry.to));
		if (first !== entry) return false;
		const from = this.current(entry.from);
		const to = this.recipient(entry.to);
		if (!from || !to || !this.allows("delivery", from, to)) {
			entry.state = "rejected";
			return false;
		}
		if (to.status === "queued") return false;
		entry.state = "delivered";
		return true;
	}

	private recipient(expected: RunAddress): LiveRun | undefined {
		const run = this.current(expected);
		if (run?.status === "running" || run?.status === "queued") return run;
	}

	private current(expected: RunAddress): LiveRun | undefined {
		if (!token(expected.id) || !token(expected.run)) return;
		const run = this.resolve(expected.id);
		if (
			run &&
			sameRun(run, expected) &&
			run.root === this.scope.root &&
			run.user === this.scope.user &&
			run.process === this.scope.process
		) {
			return run;
		}
	}

	private setMute(ids: string[], muted: boolean, matches: (entry: Entry) => boolean): void {
		if (!ids.every(token)) throw new TypeError("Invalid mailbox mute address");
		const key = JSON.stringify(ids);
		if (!muted) {
			this.mutes.delete(key);
			return;
		}
		if (this.mutes.size >= MUTE_LIMIT && !this.mutes.has(key)) throw new RangeError("Mailbox mute capacity reached");
		this.mutes.add(key);
		this.cancelWhere(matches);
	}

	private cancelWhere(matches: (entry: Entry) => boolean): void {
		for (const entry of this.entries) {
			if (entry.state === "accepted" && matches(entry)) entry.state = "cancelled";
		}
	}

	private send(from: RunAddress, to: RunAddress, key: string, payload: string): SendResult {
		const sender = this.current(from);
		if (sender?.status !== "running") return reject("stale-sender");
		if (!token(to.id) || !token(to.run)) return reject("invalid-address");
		if (!token(key)) return reject("invalid-key");
		// An exact replay returns the original receipt even after a terminal transition.
		const previous = this.entries.find((entry) => sameRun(entry.from, from) && entry.key === key);
		if (previous) {
			if (!sameRun(previous.to, to) || previous.payload !== payload) return reject("retry-conflict");
			return { id: previous.id, state: previous.state };
		}
		if (from.id === to.id) return reject("self");
		const recipient = this.recipient(to);
		if (!recipient) return reject("stale-recipient");
		if (!this.enabled) return reject("disabled");
		if ([[from.id], [to.id], [from.id, to.id]].some((ids) => this.mutes.has(JSON.stringify(ids)))) {
			return reject("muted");
		}
		if (!this.allows("send", sender, recipient)) return reject("policy");

		// UTF-8 bytes are at least the number of UTF-16 code units. Reject large strings before scanning them.
		if (payload.length > this.limits.messageBytes) return reject("message-bytes");
		const bytes = Buffer.byteLength(payload, "utf8");
		if (bytes > this.limits.messageBytes) return reject("message-bytes");
		const now = this.now();
		let pair = 0;
		let sent = 0;
		let pending = 0;
		for (const entry of this.entries) {
			if (entry.to.id === to.id && entry.state === "accepted") pending++;
			if (entry.from.id === from.id && now - entry.acceptedAt < MINUTE_MS) {
				sent++;
				if (entry.to.id === to.id) pair++;
			}
		}
		if (pair >= this.limits.pairPerMinute) return reject("pair-rate");
		if (sent >= this.limits.senderPerMinute) return reject("sender-rate");
		if (pending >= this.limits.pendingPerRecipient) return reject("recipient-capacity");
		if (this.entries.length >= this.limits.rootMessages) return reject("root-messages");
		if (this.bytes + bytes > this.limits.rootBytes) return reject("root-bytes");

		const id = this.entries.length + 1;
		this.entries.push({
			id,
			key,
			kind: "untrusted-peer-data",
			from,
			to,
			payload,
			bytes,
			acceptedAt: now,
			state: "accepted",
		});
		this.bytes += bytes;
		return { id, state: "accepted" };
	}
}
