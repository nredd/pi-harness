/** Read the host Bun API at use time; tests inject this boundary without replacing Bun's immutable global. */
export function runtimeBun() {
	return globalThis.Bun;
}
