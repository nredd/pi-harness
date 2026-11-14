/** A promise gate: an explicit rendezvous, never a polling loop or an elapsed-time wait. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let release!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		release = done;
	});
	return { promise, resolve: (value: T) => release(value) };
}
