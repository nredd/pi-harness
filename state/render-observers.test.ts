import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetState,
	clearActiveRenderSession,
	commitState,
	evictSession,
	replaceState,
	setActiveRenderSession,
	watchRenderState,
} from "./store.ts";

const empty = { tasks: [], nextId: 1 };
afterEach(__resetState);

describe("live renderer invalidation", () => {
	it("deduplicates subscriptions and ignores background writes", () => {
		setActiveRenderSession("foreground");
		const observer = { onRenderStateChange: vi.fn() };
		watchRenderState(observer);
		watchRenderState(observer);
		commitState("background", empty);
		expect(observer.onRenderStateChange).not.toHaveBeenCalled();
		commitState("foreground", empty);
		expect(observer.onRenderStateChange).toHaveBeenCalledTimes(1);
	});

	it("refreshes on replay, eviction and foreground changes", () => {
		setActiveRenderSession("foreground");
		const observer = { onRenderStateChange: vi.fn() };
		watchRenderState(observer);
		replaceState("foreground", empty);
		evictSession("foreground");
		setActiveRenderSession("other");
		setActiveRenderSession("other");
		clearActiveRenderSession();
		expect(observer.onRenderStateChange).toHaveBeenCalledTimes(4);
	});

	it("releases subscriptions on reset", () => {
		const observer = { onRenderStateChange: vi.fn() };
		watchRenderState(observer);
		__resetState();
		commitState("", empty);
		expect(observer.onRenderStateChange).not.toHaveBeenCalled();
	});
});
