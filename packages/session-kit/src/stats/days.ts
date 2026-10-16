/** Local-calendar day keys (`YYYY-MM-DD`) and day arithmetic for `/stats`. DST-safe: built from `Date(y, m, d)`. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local day key of an instant. */
export function dayKey(ms: number | Date): string {
	const d = ms instanceof Date ? ms : new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a day key. */
export function keyDate(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(key: string, n: number): string {
	const d = keyDate(key);
	return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
	return Math.round((keyDate(b).getTime() - keyDate(a).getTime()) / 86_400_000);
}

/** Every key from `from` to `to`, inclusive. Empty when `from` is after `to`. */
export function dayRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
	return out;
}

export function monthName(month: number): string {
	return MONTHS[month] ?? "";
}

/** `Oct 3` */
export function shortDate(key: string): string {
	const d = keyDate(key);
	return `${monthName(d.getMonth())} ${d.getDate()}`;
}
