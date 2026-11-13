/** Exact-HEAD review receipt and merge CLI. GitHub mutations run only after all gates. */
import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Item {
	type: string;
	text: string;
	name: string;
	arguments?: { base?: string; ref?: string; rev?: string; path?: string; pattern?: string };
}
interface Message {
	role: string;
	toolName?: string;
	isError?: boolean;
	content?: Item[];
	provider: string;
	model: string;
}

/** Refuse missing/relative executables instead of discovering authenticated tools on PATH. */
export function executable(value: string): string {
	if (!isAbsolute(value) || !statSync(value).isFile()) throw new Error(`Invalid executable: ${value}`);
	accessSync(value, constants.X_OK);
	return value;
}

/** Failed unresolved Git evidence cannot be erased by a later successful call. */
export function gitEvidence(message: Message): void {
	if (message.role !== "toolResult" || !message.toolName?.startsWith("git_")) return;
	const content = message.content;
	if (typeof message.isError !== "boolean" || !Array.isArray(content))
		throw new Error("Git result lacks boolean isError or content metadata");
	if (content.some((c) => c?.type !== "text" || typeof c.text !== "string"))
		throw new Error("Git result contains malformed text content");
	const text = content.map((c) => c.text).join("");
	if (
		message.isError &&
		(!text.trim() || /bad revision|unknown revision|ambiguous argument|Not a valid object/.test(text))
	)
		throw new Error("Failed Git result has an unresolved revision or missing diagnostic");
}

/** Parse one regular-file transcript and bind its final nonempty assistant report to axis/HEAD. */
export function receipt(root: string, task: string, axis: string, sha: string): string {
	const paths = readdirSync(root)
		.map((session) => join(root, session, "tasks", `${task}.output`))
		.filter((path) => {
			try {
				realpathSync(path);
				return true;
			} catch {
				return false;
			}
		});
	if (paths.length !== 1) throw new Error(`transcript ${task}: expected one file, got: ${paths.length}`);
	const path = realpathSync(paths[0] as string);
	if (!statSync(path).isFile()) throw new Error(`Transcript is not a file: '${path}'`);
	const models = new Set<string>();
	const reads = new Set<string>();
	let final = "";
	for (const line of readFileSync(path, "utf8").trimEnd().split("\n")) {
		const { message = {} } = JSON.parse(line) as { message?: Partial<Message> };
		gitEvidence(message as Message);
		if (message.role !== "assistant") continue;
		models.add(`${message.provider}/${message.model}`);
		for (const item of message.content ?? []) {
			if (item.type !== "toolCall") continue;
			const args = item.arguments ?? {};
			let target = args.base || args.ref || args.rev || args.path || "";
			target = target.replaceAll(homedir(), "~").split("/code/").slice(-1)[0] as string;
			if (args.pattern) target += ` /${args.pattern.slice(0, 40)}/`;
			reads.add(`\`${item.name} ${target}\``);
		}
		const text = (message.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		final = text || final;
	}
	const header = /^Axis: (Standards|Spec)\nReviewed HEAD: ([0-9a-f]{40})\n/.exec(final);
	if (
		!header ||
		header[1] !== axis ||
		header[2] !== sha ||
		final.split(/^Axis:/m).length !== 2 ||
		final.split(/^Reviewed HEAD:/m).length !== 2 ||
		!/^Checked:\n- .+/m.test(final) ||
		!/^Findings:\n.+/m.test(final)
	)
		throw new Error(`transcript: final report must declare Axis: ${axis} and Reviewed HEAD: ${sha}`);
	const split = final.indexOf("Findings:");
	const checked = final
		.slice(0, split)
		.split("\n")
		.filter((line) => line.trimStart().startsWith("- ")).length;
	const verdict = `${checked} items checked; ${final
		.slice(split + "Findings:".length)
		.trim()
		.replace(/\s+/g, " ")}`;
	if (!reads.size) throw new Error(`transcript ${task}: no model, verdict or reads`);
	return `\`${[...models].join(", ")}\`, transcript \`${task.slice(0, 8)}\`): ${verdict} Read: ${[...reads].join(", ")}`;
}

/** Literal argv, never a shell. A CLI failure refuses subsequent mutations. */
export function command(exe: string, args: string[]): string {
	return execFileSync(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Preserve non-harness all-checks behavior, including repositories without CI. */
export function otherChecks(gh: string, pr: string, repo: string, sha: string): void {
	let bad: string;
	try {
		bad = command(gh, [
			"pr",
			"checks",
			pr,
			"--repo",
			repo,
			"--json",
			"name,state",
			"-q",
			'.[] | select(.state != "SUCCESS" and .state != "SKIPPED") | "\\(.state) \\(.name)"',
		]);
	} catch (error) {
		const { stdout, stderr } = error as { stdout: string; stderr: string };
		if (`${stdout}${stderr}`.includes("no checks reported")) return;
		throw error;
	}
	if (bad.trim()) throw new Error(`CI not green on ${sha}:\n${bad.trim()}`);
}

/** Validate every input and read-only gate before posting a receipt and requesting a pinned merge. */
export function merge(argv: string[], env: NodeJS.ProcessEnv): void {
	if (argv.length < 4)
		throw new Error("Usage: merge-pr.sh <pr> <full-sha> <standards-task-id> <spec-task-id> [history-file] [repo]");
	const [pr, sha, std, spec, history = "", repository = ""] = argv as [
		string,
		string,
		string,
		string,
		string?,
		string?,
	];
	// Match the shell's ${6:-default}: empty and absent both select the harness.
	const repo = repository || "nredd/pi-harness";
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected full reviewed HEAD SHA");
	if (std === spec) throw new Error("Standards and Spec require distinct transcript IDs");
	if (!/^[a-zA-Z0-9-]+$/.test(std) || !/^[a-zA-Z0-9-]+$/.test(spec)) throw new Error("Invalid transcript ID");
	const root = env.MERGE_PR_TRANSCRIPT_ROOT ?? "";
	if (!isAbsolute(root) || !statSync(root).isDirectory()) throw new Error(`Invalid transcript root: ${root}`);
	const gh = executable(env.MERGE_PR_GH ?? "");
	const python = executable(env.MERGE_PR_PYTHON ?? "");
	const stdLine = receipt(root, std, "Standards", sha);
	const specLine = receipt(root, spec, "Spec", sha);
	const head = command(gh, ["pr", "view", pr, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]).trim();
	if (head !== sha) throw new Error(`PR head ${head} != reviewed ${sha}`);
	if (repo === "nredd/pi-harness")
		command(python, [join(dirname(fileURLToPath(import.meta.url)), "merge_pr_checks.py"), pr, sha, repo, "--gh", gh]);
	else otherChecks(gh, pr, repo, sha);
	let body = `Review receipt, final HEAD \`${sha}\`:\n\n- Standards (\`code-reviewer\`, ${stdLine}\n- Spec (\`code-reviewer\`, ${specLine}\n`;
	if (history) body += `\n${readFileSync(history, "utf8")}`;
	console.log(body.trimEnd());
	const directory = mkdtempSync(join(tmpdir(), "merge-pr-"));
	try {
		const path = join(directory, "receipt.md");
		writeFileSync(path, body);
		console.log(command(gh, ["pr", "comment", pr, "--repo", repo, "--body-file", path]).trim());
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	console.log(command(gh, ["pr", "merge", pr, "--repo", repo, "--merge", "--match-head-commit", sha]).trim());
	console.log(command(gh, ["pr", "view", pr, "--repo", repo, "--json", "state", "-q", ".state"]).trim());
}

/** CLI boundary: surface validation, IO and child errors as nonzero refusals. */
export function main(argv: string[], env: NodeJS.ProcessEnv): number {
	try {
		merge(argv, env);
		return 0;
	} catch (error) {
		console.error(error);
		return 1;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2), process.env);
