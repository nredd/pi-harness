/**
 * Bound what the model sees from `monitor_read` / `monitor_stop` at pi's own limits
 * (`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`), keeping the newest lines and spilling the full text
 * to a temp file. Same idea as `pi-dev-tools`' `core/output.ts`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

export interface Bounded {
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}

/** Room reserved for the truncation notice inside the limits. */
const NOTICE_BYTES = 256;
const NOTICE_LINES = 2;

let spillDir: Promise<string> | undefined;
let spillSeq = 0;

export async function boundTail(text: string, label: string): Promise<Bounded> {
	const result = truncateTail(text, {
		maxBytes: DEFAULT_MAX_BYTES - NOTICE_BYTES,
		maxLines: DEFAULT_MAX_LINES - NOTICE_LINES,
	});
	if (!result.truncated) return { text, truncated: false };
	spillDir ??= mkdtemp(join(tmpdir(), "pi-session-kit-monitor-"));
	const dir = await spillDir;
	spillSeq += 1;
	const fullOutputPath = join(dir, `${label}-${spillSeq}.txt`);
	await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
	return {
		text: `${result.content}\n[output truncated at the start; full text in ${fullOutputPath}]`,
		truncated: true,
		fullOutputPath,
	};
}
