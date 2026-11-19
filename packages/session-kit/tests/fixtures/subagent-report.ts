/** Synthetic session records shared by local subagent accounting fixtures. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const timestamp = "2026-01-01T00:00:00.000Z";
export const header = (id: string, parentSession?: string) => ({ type: "session", id, parentSession, timestamp });
export const info = (name: string) => ({ type: "session_info", name, timestamp });
export const call = (id: string, cost: unknown = { total: 2 }, extra = {}) => ({
	type: "message",
	id,
	timestamp,
	message: {
		role: "assistant",
		provider: "example",
		model: "model-a",
		timestamp,
		usage: { input: 10, output: 3, cacheRead: 7, cacheWrite: 4, cost },
		...extra,
	},
});

/** Write literal malformed lines unchanged alongside serialized synthetic records. */
export async function writeSession(root: string, name: string, entries: unknown[]): Promise<string> {
	const path = join(root, name);
	await writeFile(path, entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"));
	return path;
}
