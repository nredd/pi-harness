/** CI-only discovery receipt from the actual Pi host and registered Agent schema. */
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	getAgentDir,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Observe package filtering without installing, changing settings or replacing a footer. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const destination = process.env.HARNESS_RESOURCE_REPORT;
		const preset = process.env.HARNESS_PRESET_ROOT;
		if (!destination || !preset) throw new Error("Stack resource probe requires explicit report and preset paths");
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const manager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
		const resources = await manager.resolve(async (source) => {
			throw new Error(`Stack resource probe refuses missing source: ${source}`);
		});
		const enabled = (entries: ResolvedResource[]): string[] =>
			entries
				.filter((entry) => entry.enabled)
				.map((entry) => relative(preset, entry.path))
				.filter((path) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
				.sort();
		const agent = pi.getAllTools().find((tool) => tool.name === "Agent");
		if (!agent) throw new Error("Stack resource probe cannot find the registered Agent tool");
		writeFileSync(
			destination,
			JSON.stringify({
				resources: {
					extensions: enabled(resources.extensions),
					skills: enabled(resources.skills),
					prompts: enabled(resources.prompts),
					themes: enabled(resources.themes),
				},
				agentParameters: agent.parameters,
			}),
		);
	});
}
