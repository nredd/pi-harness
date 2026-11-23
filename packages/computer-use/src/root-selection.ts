import type { PlatformRoot } from "./platform/types.ts";

type RankedRoot = Pick<
	PlatformRoot,
	"windowId" | "windowRef" | "isModal" | "isFocused" | "isMain" | "isMinimized" | "isOnscreen" | "zOrder" | "title"
>;

/**
 * Rank a root. A state flag scores only on an explicit read: an unknown (`undefined`) `isFocused`, `isMain` or
 * `isOnscreen` earns no bonus, and only an explicit `isMinimized: false` earns the not-minimized one.
 */
export function scoreWindow(window: RankedRoot): number {
	let score = 0;
	if (window.isModal) score += 180;
	if (window.isFocused) score += 100;
	if (window.isMain) score += 80;
	if (window.isMinimized === false) score += 40;
	if (window.isOnscreen) score += 20;
	if (window.windowId && window.windowId > 0) score += 10;
	if (window.title.trim().length > 0) score += 2;
	return score;
}

/**
 * Switch the target to a foreground modal only on read evidence: the modal must read `isOnscreen: true` (unknown
 * disqualifies), an explicit `isMinimized: true` disqualifies (unknown does not, its onscreen read already shows it),
 * and an unknown `isFocused` is not focus, so it is in front only by z-order.
 */
export function shouldPreferForegroundModalWindow(current: RankedRoot, candidate: RankedRoot): boolean {
	if (candidate.windowId === current.windowId && candidate.windowRef === current.windowRef) return false;
	if (candidate.isOnscreen !== true || candidate.isMinimized === true || !candidate.isModal) return false;
	// AXDialog can describe a background main window, so modality alone is insufficient.
	const candidateIsInFront = candidate.isFocused === true || candidate.zOrder < current.zOrder;
	return candidateIsInFront && scoreWindow(candidate) >= scoreWindow(current);
}
