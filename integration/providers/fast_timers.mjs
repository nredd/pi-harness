// Node preload (`--import`) that shortens chosen timer delays; never installed.
//
// `HARNESS_TIMER_MAP` is JSON `{ "<delay ms>": <replacement ms> }`. `setTimeout` and `setInterval`
// calls whose delay is EXACTLY a key run with the replacement instead, so the quota footer's 60 s
// poll and 12 s request timeout fit in a test without a fake clock (no pi build exposes one). Every
// other delay is untouched. Date and `Date.now()` are not scaled.
const raw = process.env.HARNESS_TIMER_MAP;
if (!raw) throw new Error("fast_timers.mjs needs HARNESS_TIMER_MAP");
const map = new Map(
	Object.entries(JSON.parse(raw)).map(([from, to]) => [
		Number(from),
		Number(to),
	]),
);

for (const name of ["setTimeout", "setInterval"]) {
	const original = globalThis[name];
	globalThis[name] = (callback, delay, ...args) =>
		original(callback, map.get(Number(delay)) ?? delay, ...args);
}
