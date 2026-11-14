/**
 * Todo's presets over the shared recording doubles in `@nredd/pi-test-lib/pi`: a disposable
 * cwd, and `createTodoPi` returning the pi next to its recording as `captured`.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	createRecordingContext,
	createRecordingPi,
	type RecordingContextOptions,
	type RecordingPi,
	type RecordingPiOptions,
} from "@nredd/pi-test-lib/pi";

/** Top-level members replace the matching `ExtensionAPI` methods, as the upstream double did. */
export function createTodoPi(options: Partial<ExtensionAPI> & Pick<RecordingPiOptions, "skills"> = {}) {
	const { skills, ...overrides } = options;
	const captured = createRecordingPi({ thinkingLevel: "medium", skills, overrides });
	return { pi: captured.pi, captured };
}

export type CapturedPi = RecordingPi;

/** A tool `execute()` / command context. */
export function createTodoCtx(options: RecordingContextOptions = {}) {
	return createRecordingContext({ cwd: "/tmp/test-cwd", ...options }).ctx;
}

/** No theme unless given: the overlay falls back to the one its widget factory receives. */
export function createTodoUI(overrides: Partial<ExtensionUIContext> = {}) {
	return createTodoCtx({ ui: { theme: undefined, ...overrides } as Partial<ExtensionUIContext> }).ui;
}
