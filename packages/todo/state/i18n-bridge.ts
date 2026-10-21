/**
 * i18n bridge for rpiv-todo — single thin import surface so every call site
 * routes through one module. Backed by `@juicesharp/rpiv-i18n`'s SDK, a hard
 * dependency of `@nredd/pi-todo`; the English fallback is retained but is
 * unreachable in a normal install.
 *
 * - `t(key, fallback)` is `scope("@juicesharp/rpiv-todo")` (live `/languages`
 *   updates propagate). The namespace keeps its upstream name for locale and
 *   session compatibility. If the SDK import fails anyway (broken install),
 *   `t` is an identity passthrough that returns the inline English fallback
 *   at every call site, so the extension stays online with English UI.
 * - `formatStatusLabel(status)` resolves a TaskStatus to its locale-aware
 *   label via the canonical `status.*` namespace, with the English literal
 *   as fallback so nothing renders blank if the namespace isn't registered.
 *   This is the SINGLE point of localization for status words — overlay,
 *   /todos header, /todos render-call all route through here.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = formatStatusLabel(...)`.
 */

import type { TaskStatus } from "../tool/types.ts";
import { selectPlanProgress } from "./plan.ts";
import { selectTodoCounts } from "./selectors.ts";
import type { TaskState } from "./state.ts";

export const I18N_NAMESPACE = "@juicesharp/rpiv-todo";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

// Use the live SDK: closures it returns track the active locale, so the
// /languages picker propagates to our render call sites. rpiv-i18n is now a
// hard dependency, so the catch below is unreachable in a normal install; it
// is kept as a defensive fallback (a broken install still returns the
// canonical English literal and the extension stays online).
//
// Top-level await is required so a synchronous `t(...)` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.
let scopeImpl: ScopeFn;
try {
	const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
	scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
	scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";
const STATUS_LABEL_DEFERRED = "deferred";

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return t("status.pending", STATUS_LABEL_PENDING);
		case "in_progress":
			return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
		case "completed":
			return t("status.completed", STATUS_LABEL_COMPLETED);
		case "deferred":
			return t("status.deferred", STATUS_LABEL_DEFERRED);
		case "deleted":
			return t("status.deleted", STATUS_LABEL_DELETED);
	}
}

const PLAN_OPEN = "{open}/{total} plan items open";

/** `N/M plan items open`, localized; shared by the overlay heading and `/todos`. */
export function formatPlanOpen(open: number, total: number): string {
	return t("overlay.planOpen", PLAN_OPEN).replace("{open}", String(open)).replace("{total}", String(total));
}

const PROGRESS_DONE = "done";
const PROGRESS_OPEN = "open";

/** Paints one heading chunk; `warning` marks the in-progress segment. */
export type ProgressPaint = (kind: "base" | "warning", text: string) => string;

const plainPaint: ProgressPaint = (_kind, text) => text;

/**
 * Heading progress, e.g. `19 done, 1 deferred, 4 open, 2 in progress`. Computed
 * from the full state (never the rows the overlay happens to show), so the
 * numbers always sum to the total. `open` is every not-done task and
 * `in progress` is a subset of it. Zero buckets are omitted. With plan items AND
 * other todos it appends the plan's own `N/M plan items open`. `paint` colors
 * the in-progress segment (and the rest as `base`); the default is plain text.
 */
export function formatProgress(state: TaskState, paint: ProgressPaint = plainPaint): string {
	const counts = selectTodoCounts(state);
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(paint("base", `${counts.completed} ${t("overlay.done", PROGRESS_DONE)}`));
	if (counts.deferred > 0) parts.push(paint("base", `${counts.deferred} ${formatStatusLabel("deferred")}`));
	const open = counts.pending + counts.inProgress;
	if (open > 0) parts.push(paint("base", `${open} ${t("overlay.open", PROGRESS_OPEN)}`));
	if (counts.inProgress > 0) {
		parts.push(paint("warning", `${counts.inProgress} ${formatStatusLabel("in_progress")}`));
	}
	let text = parts.join(paint("base", ", "));
	const plan = selectPlanProgress(state);
	const planCount = state.tasks.filter((x) => x.source === "plan" && x.status !== "deleted").length;
	if (plan && counts.total > planCount) text += paint("base", ` · ${formatPlanOpen(plan.open, plan.total)}`);
	return text;
}
