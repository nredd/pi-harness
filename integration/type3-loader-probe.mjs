// Disposable probe: patch ONLY the CI checkout before building, never the Gitlinked core.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const filename = process.argv.at(-1);
assert.ok(filename?.endsWith("/extensions/loader.ts"), "Supply the core extension loader path");
let source = readFileSync(filename, "utf8");
const snapshot = `
async function type3Snapshot(stage: string): Promise<void> {
	try {
		console.error("[TYPE3] snapshot", stage);
		const modules = await getVirtualModules();
		for (const name of ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-ai/compat"]) {
			const namespace = modules[name] as Record<string, unknown>;
			const descriptor = Object.getOwnPropertyDescriptor(namespace, "Type");
			console.error("[TYPE3] Type descriptor", name, JSON.stringify({
				enumerable: descriptor?.enumerable, configurable: descriptor?.configurable,
				writable: descriptor?.writable, getter: descriptor?.get?.toString(),
				setter: descriptor?.set?.toString(), valueType: typeof descriptor?.value,
				valueKeys: descriptor?.value && Object.keys(descriptor.value),
			}));
			try { console.error("[TYPE3] Type read", name, typeof namespace.Type); }
			catch (readError) { console.error("[TYPE3] Type read failed", readError instanceof Error ? readError.stack : readError); }
		}
		const ai = modules["@earendil-works/pi-ai/compat"] as Record<string, unknown>;
		console.error("[TYPE3] StringEnum.toString()", String(ai.StringEnum));
	} catch (diagnosticError) {
		console.error("[TYPE3] diagnostic failed", diagnosticError instanceof Error ? diagnosticError.stack : diagnosticError);
	}
}

`;
const replacements = [
  ['async function loadExtensionModule(', `${snapshot}async function loadExtensionModule(`],
  [
    'const module = await jiti.import(extensionPath, { default: true });',
    `console.error("[TYPE3] importing", extensionPath);
	let module;
	try {
		module = await jiti.import(extensionPath, { default: true });
		console.error("[TYPE3] imported", extensionPath);
	} catch (error) {
		console.error("[TYPE3] import failed", extensionPath, error instanceof Error ? error.stack : error);
		try {
			const transformed = jiti.transform({ source: fs.readFileSync(extensionPath, "utf8"), filename: extensionPath, ts: extensionPath.endsWith(".ts"), async: true });
			const dir = process.env.TYPE3_DIAGNOSTIC_DIR;
			if (dir) {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "failed-transform.js"), transformed);
			}
			console.error("[TYPE3] transform references", transformed.split("\\n").filter((line) => /Type3|StringEnum/.test(line)).join("\\n"));
		} catch (transformError) {
			console.error("[TYPE3] transform failed", transformError instanceof Error ? transformError.stack : transformError);
		}
		throw error;
	}`,
  ],
  [
    'await factory(load.api);',
    `console.error("[TYPE3] factory", extensionPath);
		if (extensionPath.includes("/pi-memory/")) await type3Snapshot("before memory factory");
		await factory(load.api);
		console.error("[TYPE3] factory passed", extensionPath);
		if (extensionPath.includes("/pi-memory/")) await type3Snapshot("after memory factory");`,
  ],
  [
    'const message = err instanceof Error ? err.message : String(err);',
    `console.error("[TYPE3] extension failed", resolvedPath, err instanceof Error ? err.stack : err);
		await type3Snapshot("extension failed: " + resolvedPath);
		const message = err instanceof Error ? err.stack ?? err.message : String(err);`,
  ],
];
for (const [before, after] of replacements) {
  assert.equal(source.split(before).length, 2, `Expected exactly one patch site: ${before}`);
  source = source.replace(before, after);
}
if (process.argv.includes("--check")) {
  console.log("TYPE3 patch sites verified; no files changed");
} else {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "This temporary core patch is CI-only");
  writeFileSync(filename, source);
  console.log("TYPE3 temporary CI-only loader patch applied");
}
