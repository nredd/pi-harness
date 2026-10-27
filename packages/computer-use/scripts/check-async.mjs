// Readiness gates for check fixtures: no scheduler-dependent startup delays.
export function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Bound an observable readiness/completion promise and always clear its watchdog. */
export async function within(promise, label, timeoutMs = 5000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label}`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
