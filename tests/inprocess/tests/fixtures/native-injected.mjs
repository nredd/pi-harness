/** Import one injected fork testing specifier (argv[2]) under the guard and print the outcome. */
import "./native-guard.mjs";

const sdk = await import("@earendil-works/pi-coding-agent");
let error;
try {
	await import(process.argv[2]);
} catch (cause) {
	error = cause.message;
}
console.log(JSON.stringify({ publicSdk: typeof sdk.AgentSession === "function", error }));
