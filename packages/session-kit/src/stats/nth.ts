/**
 * `items[index]` for an index the caller has already bounded (a loop counter, a modulo, a length-matched
 * table). `noUncheckedIndexedAccess` types the read as possibly undefined; a `?? fallback` would add a
 * branch that can never run, so the bound is asserted here once instead.
 */
export function nth<T>(items: readonly T[], index: number): T {
	return items[index] as T;
}
