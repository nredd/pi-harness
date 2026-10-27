/** Input validation for `monitor_start`: argv, name, match regex, timeout. */

export const MAX_MONITORS = 5;
export const DEFAULT_TIMEOUT_S = 3600;
export const MAX_TIMEOUT_S = 604_800;
export const MAX_NAME_LENGTH = 40;
export const MAX_MATCH_LENGTH = 500;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface StartParams {
	argv: string[];
	name: string;
	match?: string;
	wake?: boolean;
	timeout_s?: number;
}

export interface ValidStart {
	argv: string[];
	name: string;
	regex: RegExp | undefined;
	wake: boolean;
	timeoutMs: number;
}

export type Validation = { ok: true; value: ValidStart } | { ok: false; error: string };

export function validateStart(input: StartParams, liveNames: ReadonlySet<string>, liveCount: number): Validation {
	const { argv, name } = input;
	if (!Array.isArray(argv) || argv.length === 0) return fail("argv must be a non-empty array");
	if (argv.some((a) => typeof a !== "string" || a.includes("\0")))
		return fail("argv entries must be strings without NUL");
	if (argv[0]?.trim() === "") return fail("argv[0] must be a non-empty command");
	if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) {
		return fail(`name must match ${NAME_RE.source} and be at most ${MAX_NAME_LENGTH} characters`);
	}
	if (liveNames.has(name)) return fail(`a running monitor is already named "${name}"`);
	if (liveCount >= MAX_MONITORS) return fail(`at most ${MAX_MONITORS} monitors can run at once; stop one first`);

	let regex: RegExp | undefined;
	if (input.match !== undefined && input.match !== "") {
		if (input.match.length > MAX_MATCH_LENGTH) return fail(`match must be at most ${MAX_MATCH_LENGTH} characters`);
		try {
			regex = new RegExp(input.match);
		} catch (error) {
			return fail(`match is not a valid regex: ${(error as Error).message}`);
		}
	}

	const timeoutS = input.timeout_s ?? DEFAULT_TIMEOUT_S;
	if (!Number.isFinite(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) {
		return fail(`timeout_s must be between 1 and ${MAX_TIMEOUT_S}`);
	}
	return { ok: true, value: { argv, name, regex, wake: input.wake === true, timeoutMs: Math.round(timeoutS * 1000) } };
}

function fail(error: string): Validation {
	return { ok: false, error };
}
