/** Number and duration formatting for `/stats`. */

/**
 * `999`, `12k`, `999k`, `1M`, `1.2M`, `3.4B`: whole numbers below 1k, `k` with no decimals, `M`/`B`
 * with one decimal minus a trailing `.0`. A value that rounds up to 1000 of a unit moves up a unit.
 */
export function formatTokens(n: number): string {
	const abs = Math.abs(n);
	if (abs < 999.5) return String(Math.round(n));
	if (abs < 999_500) return `${Math.round(n / 1e3)}k`;
	if (abs < 999_950_000) return `${trim((n / 1e6).toFixed(1))}M`;
	return `${trim((n / 1e9).toFixed(1))}B`;
}

/**
 * A y-axis tick. Same as `formatTokens` unless that would round the tick (a `2.5k` step), in which
 * case one decimal is kept so labels never lie about where the gridline is.
 */
export function axisLabel(n: number): string {
	const plain = formatTokens(n);
	const unit = plain.endsWith("k") ? 1e3 : plain.endsWith("M") ? 1e6 : plain.endsWith("B") ? 1e9 : 1;
	if (unit === 1 || Math.abs(Number.parseFloat(plain) * unit - n) < unit / 1e4) return plain;
	return `${trim((n / unit).toFixed(1))}${plain.slice(-1)}`;
}

function trim(fixed: string): string {
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** `$0.42`, `$12.30`, `$1.2k` */
export function money(n: number): string {
	return n >= 1000 ? `$${trim((n / 1e3).toFixed(1))}k` : `$${n.toFixed(2)}`;
}

/** `27s`, `14m`, `3h 5m`, `2d 4h` */
export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function percent(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%";
}
