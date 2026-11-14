import { join } from "node:path";
import { expect, it } from "vitest";
import { isolatedHomeEnv } from "../src/isolated-home.ts";

it("points every home-derived variable under the given home", () => {
	const home = join("/", "tmp", "h");
	expect(isolatedHomeEnv(home)).toEqual({
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_SUBAGENTS_CONFIG_DIR: join(home, ".pi", "agent"),
	});
});
