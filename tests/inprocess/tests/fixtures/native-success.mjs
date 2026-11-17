/** Prompt a real public-SDK stack, refuse an unavailable tool, and print one JSON receipt. */
import { imports } from "./native-guard.mjs";

const { existsSync } = await import("node:fs");
const { isolateStackHome, startStack } = await import("../../support.ts");
const { fauxAssistantMessage } = await import("../../../lib/src/harness.ts");
const { toolCall, outcomes } = await import("../../../lib/src/faux.ts");

const home = await isolateStackHome();
let harness;
let receipt;
try {
	harness = await startStack({ cwd: home.root, factories: [] });
	harness.setResponses([
		fauxAssistantMessage("STACK OK"),
		toolCall("missing_tool", {}),
		fauxAssistantMessage("refused"),
	]);
	await harness.session.prompt("hello");
	const first = harness.session.getLastAssistantText();
	await harness.session.prompt("call missing");
	receipt = {
		first,
		results: outcomes(harness, "missing_tool"),
		pending: harness.getPendingResponseCount(),
		imports: [...imports],
	};
} finally {
	harness?.cleanup();
	await home.cleanup();
}
console.log(JSON.stringify({ ...receipt, cleaned: !existsSync(home.root) }));
