/** Real child router with the same explicit fixture dependencies as its parent. */
import {
	createSubscriptionRouter,
	type SubscriptionRouterOptions,
} from "../../../packages/subscription-router/src/index.ts";

const options = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-harness:tier-router")];
if (!options) throw new Error("Missing tier-router fixture options");
export default createSubscriptionRouter(options as SubscriptionRouterOptions);
