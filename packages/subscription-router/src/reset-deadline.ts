/** Remaining milliseconds projected into a caller's current wall-clock frame. */
export type ResetDeadline = (wallNow: number) => number;

/** Keep the provider's timestamp intact and retain only the shortest observed reset budget. */
export function anchorReset(
	resetAt: number,
	wallAtRead: number,
	monotonicAtRead: number,
	monotonicNow: () => number,
): ResetDeadline {
	let expires = resetAt - wallAtRead;
	return (wallNow) => {
		const elapsed = Math.floor(monotonicNow() - monotonicAtRead);
		// A forward step may shorten or expire the block. A later rollback cannot undo that.
		expires = Math.min(expires, elapsed + (resetAt - wallNow));
		return wallNow + (expires - elapsed);
	};
}
