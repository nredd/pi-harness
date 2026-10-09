import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const BUILTIN_SAFE_GIT_SUBCOMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "ls-files",
  "grep",
] as const;
export const CONFIGURABLE_SAFE_GIT_SUBCOMMANDS = [
  "rev-parse",
  "blame",
  "describe",
  "merge-base",
  "ls-tree",
  "cat-file",
] as const;
export const SAFE_GIT_SUBCOMMANDS = [...BUILTIN_SAFE_GIT_SUBCOMMANDS, ...CONFIGURABLE_SAFE_GIT_SUBCOMMANDS] as const;
export const SAFE_GH_SUBCOMMAND_PATHS = ["pr view", "pr list", "issue view", "issue list"] as const;

export type BuiltinSafeGitSubcommand = (typeof BUILTIN_SAFE_GIT_SUBCOMMANDS)[number];
export type ConfigurableSafeGitSubcommand = (typeof CONFIGURABLE_SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGitSubcommand = (typeof SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGhSubcommandPath = (typeof SAFE_GH_SUBCOMMAND_PATHS)[number];
export interface SafeSubcommands {
  [command: string]: string[] | undefined;
}

export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "powershell", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "limited" | "user-opt-in" | "blocked";

const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "dd",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "vim",
  "vi",
  "nano",
  "emacs",
  "code",
  "subl",
]);
const READ_ONLY_POWERSHELL_COMMANDS = new Set([
  "format-list",
  "format-table",
  "get-childitem",
  "get-content",
  "get-item",
  "get-location",
  "measure-object",
  "out-string",
  "resolve-path",
  "select-string",
  "sort-object",
  "test-path",
  "write-output",
]);
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "ls",
  "pwd",
  "echo",
  "printf",
  "wc",
  "sort",
  "uniq",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "uptime",
  "ps",
  "jq",
  "rg",
  "fd",
  "bat",
  "eza",
]);

// `-i` edits in place for sed. For these inspection commands it is case-insensitive
// search or inode output, which is how plan mode reads markdown and other text.
const INSPECTION_CASE_FLAG_COMMANDS = new Set(["rg", "grep", "git", "diff", "fd", "ls", "sort", "find", "bat", "eza"]);

export function isBuiltinTool(tool: ToolInfo) {
  const source = tool.sourceInfo;
  if (source?.source !== "builtin") return false;
  // Core tools own builtin:<name>; built-in extensions may own many tools or
  // expose model-only orchestration. Missing paths preserve legacy core policy.
  return !source.path || (source.path === `builtin:${tool.name}` && tool.exposure !== "model-only");
}

/**
 * A tool from an installed extension (local file or package) whose author declares it does not
 * modify its environment. Built-in extensions, including native MCP (`builtin:mcp`), are excluded:
 * their annotations come from third-party servers and still need explicit opt-in.
 */
export function isAnnotatedReadOnlyTool(tool: ToolInfo) {
  const source = tool.sourceInfo;
  if (!source?.source || source.source === "builtin" || source.path?.startsWith("builtin:")) return false;
  return tool.annotations?.readOnlyHint === true;
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (!tool.sourceInfo?.source) return "blocked";
  if (isAnnotatedReadOnlyTool(tool)) return "read-only";
  if (!isBuiltinTool(tool)) return "user-opt-in";
  if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
  if (tool.name === "bash" || tool.name === "powershell") return "limited";
  return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
  return classifyPlanModeTool(tool) !== "blocked";
}

export function readCommand(input: unknown) {
  const command = input as { command?: unknown } | undefined;
  return typeof command?.command === "string" ? command.command : "";
}

/** The typed remote-shell tool Plan mode re-validates like `ssh <host> <command>`. */
export const SSH_EXEC_TOOL_NAME = "ssh_exec";

/**
 * Returns why an `ssh_exec` call is rejected, or `undefined` when it passes: the host must be a
 * configured `ssh` prefix and the remote command must pass the remote reviewed policy.
 */
export function findBlockedSshExecCall(
  input: unknown,
  safeSubcommands: SafeSubcommands = {},
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const call = input as { host?: unknown; command?: unknown } | undefined;
  const host = typeof call?.host === "string" ? call.host.trim() : "";
  if (!host) return "host is required";
  if (!(safeSubcommands.ssh ?? []).some((prefix) => prefix.trim() === host)) {
    return `host '${host}' is not a configured ssh prefix`;
  }
  const command = readCommand(input);
  const blocked = findBlockedCommandSegment(command, safeSubcommands, undefined, platform, [], true);
  return blocked === undefined ? undefined : `remote command: ${blocked}`;
}

/**
 * Returns the first command segment the reviewed Bash policy rejects, or `undefined` when the whole
 * command is acceptable.
 *
 * - A configured `safeSubcommands` prefix approves *only the segment it starts*; every other segment
 *   of a `&&`/`||`/`;`/`|` list is validated independently.
 * - Redirections, substitutions, and piping into an interpreter are always rejected.
 * - `cd <dir>` and `git -C <dir>` are accepted only for directories under `workingDirectory` or one of
 *   `trustedDirectories`; `cd` moves the effective directory for the following segments.
 * - `remote` re-validates the command of an `ssh <host> <command>` on the other side, where local
 *   directories mean nothing, so `cd` and `git -C` are rejected.
 */
export function findBlockedCommandSegment(
  command: string,
  safeSubcommands: SafeSubcommands = {},
  workingDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  trustedDirectories: readonly string[] = [],
  remote = false,
): string | undefined {
  const segments = splitShellSegments(command);
  if (!segments || segments.length === 0) return command.trim() || "(empty command)";
  const roots = allowedRoots(remote ? undefined : workingDirectory, remote ? [] : trustedDirectories);
  let base = remote ? undefined : workingDirectory;
  for (const [index, segment] of segments.entries()) {
    if (segment.separator === "|" && isInterpreterCommand(firstWord(segment.text), INTERPRETERS)) return segment.text;
    const tokens = shellWords(segment.text);
    if (tokens?.[0] === "cd" && matchConfiguredPrefix(segment.text, safeSubcommands) === undefined) {
      const target =
        tokens.length === 2 && !hasShellExpansion(segment.text) ? resolveDirectory(tokens[1], base, roots) : undefined;
      if (target === undefined || segments[index + 1]?.separator === "|") return segment.text;
      base = target;
      continue;
    }
    const paths: PathPolicy = { base, roots };
    if (!isSafeSegment(segment.text, safeSubcommands, paths, platform)) return segment.text;
  }
  return undefined;
}

export function isSafeCommand(
  command: string,
  safeSubcommands: SafeSubcommands = {},
  workingDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  trustedDirectories: readonly string[] = [],
) {
  return (
    findBlockedCommandSegment(command, safeSubcommands, workingDirectory, platform, trustedDirectories) === undefined
  );
}

export function findBlockedPowerShellCommandSegment(
  command: string,
  safeSubcommands: SafeSubcommands = {},
  workingDirectory?: string,
  trustedDirectories: readonly string[] = [],
): string | undefined {
  const segments = splitPowerShellSegments(command);
  if (!segments || segments.length === 0) return command.trim() || "(empty command)";
  const paths: PathPolicy = { base: workingDirectory, roots: allowedRoots(workingDirectory, trustedDirectories) };
  return segments.find(
    (segment) =>
      (segment.separator === "|" && isInterpreterCommand(firstWord(segment.text), POWERSHELL_INTERPRETERS)) ||
      !isSafePowerShellSegment(segment.text, safeSubcommands, paths),
  )?.text;
}

export function isSafePowerShellCommand(
  command: string,
  safeSubcommands: SafeSubcommands = {},
  workingDirectory?: string,
  trustedDirectories: readonly string[] = [],
) {
  return (
    findBlockedPowerShellCommandSegment(command, safeSubcommands, workingDirectory, trustedDirectories) === undefined
  );
}

type ShellSeparator = "start" | "&&" | "||" | ";" | "|";
interface ShellSegment {
  text: string;
  /** The operator that precedes this segment (`start` for the first one). */
  separator: ShellSeparator;
}

/** Directories a `cd`/`git -C` may target (`roots`) and the directory relative paths resolve from (`base`). */
interface PathPolicy {
  base: string | undefined;
  roots: readonly string[];
}

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "python",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "awk",
  "gawk",
  "mawk",
  "osascript",
  "pwsh",
  "powershell",
  "env",
  "xargs",
  "eval",
  "exec",
  "source",
  "sudo",
  "su",
]);
const POWERSHELL_INTERPRETERS = new Set([
  ...INTERPRETERS,
  "cmd",
  "invoke-expression",
  "iex",
  "invoke-command",
  "start-process",
]);

function firstWord(segment: string) {
  return segment.trim().split(/\s+/u, 1)[0] ?? "";
}

function isInterpreterCommand(word: string, interpreters: ReadonlySet<string>) {
  const name = (word.split(/[\\/]/u).pop() ?? "").toLowerCase().replace(/\.exe$/u, "");
  return interpreters.has(name) || /^(?:python|ruby|perl|php|lua)[\d.]*$/u.test(name);
}

/**
 * Returns the configured `<command> <subcommand>` prefix that starts `segment`, if any.
 * A match needs the next character to be whitespace/end, or the prefix itself to end in a
 * non-alphanumeric character (`gh api repos/` matches `gh api repos/x`; `kubectl apply` does not
 * match `kubectl applies`).
 */
function matchConfiguredPrefix(segment: string, safeSubcommands: SafeSubcommands): string | undefined {
  const candidate = segment.trimStart();
  for (const [configuredCommand, subcommands] of Object.entries(safeSubcommands)) {
    for (const subcommand of subcommands ?? []) {
      const prefix = `${configuredCommand.trim()} ${subcommand.trim()}`;
      if (!configuredCommand.trim() || !subcommand.trim() || !candidate.startsWith(prefix)) continue;
      const boundary = candidate[prefix.length];
      const endsBounded = !/[A-Za-z0-9]$/u.test(prefix);
      if (boundary === undefined || /\s/u.test(boundary) || endsBounded) return prefix;
    }
  }
  return undefined;
}

function expandTilde(path: string): string | undefined {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path.startsWith("~") ? undefined : path;
}

function allowedRoots(workingDirectory: string | undefined, trustedDirectories: readonly string[]) {
  const roots: string[] = [];
  if (workingDirectory) roots.push(resolve(workingDirectory));
  for (const directory of trustedDirectories) {
    const expanded = expandTilde(directory.trim());
    if (expanded && isAbsolute(expanded)) roots.push(resolve(expanded));
  }
  return roots;
}

function isUnder(path: string, root: string) {
  const difference = relative(root, path);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

/**
 * Resolves a directory argument of `cd`/`git -C`: no flags, no `..`, only a leading `~` expanded,
 * and the result must sit under the working directory or a trusted directory.
 */
function resolveDirectory(raw: string | undefined, base: string | undefined, roots: readonly string[]) {
  if (!raw || raw.startsWith("-") || raw.split(/[\\/]+/u).includes("..")) return undefined;
  const expanded = expandTilde(raw);
  if (expanded === undefined) return undefined;
  if (!isAbsolute(expanded) && base === undefined) return undefined;
  const resolved = resolve(base ?? "/", expanded);
  return roots.some((root) => isUnder(resolved, root)) ? resolved : undefined;
}

function splitPowerShellSegments(command: string): ShellSegment[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\n\r`\u2018-\u201e]/.test(trimmed)) return undefined;

  const segments: ShellSegment[] = [];
  let separator: ShellSeparator = "start";
  let quote: "'" | '"' | undefined;
  let start = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === "'") {
      if (character !== "'") continue;
      if (trimmed[index + 1] === "'") {
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === "$" || character === "`") return undefined;
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (["$", "@", "#", "!", "?", "{", "}", "(", ")", "[", "]", ">", "<"].includes(character)) {
      return undefined;
    }
    const next = trimmed[index + 1];
    if (character === "&" || (character === "|" && next === "|")) return undefined;
    const separatorLength = character === ";" || character === "|" ? 1 : 0;
    if (separatorLength === 0) continue;
    const segment = trimmed.slice(start, index).trim();
    if (!segment) return undefined;
    segments.push({ text: segment, separator });
    separator = character === "|" ? "|" : ";";
    index += separatorLength - 1;
    start = index + 1;
  }
  if (quote) return undefined;
  const finalSegment = trimmed.slice(start).trim();
  if (!finalSegment) return undefined;
  segments.push({ text: finalSegment, separator });
  return segments;
}

function isSafePowerShellSegment(segment: string, safeSubcommands: SafeSubcommands, paths: PathPolicy) {
  if (matchConfiguredPrefix(segment, safeSubcommands) !== undefined) return true;
  const tokens = powerShellWords(segment);
  if (!tokens || tokens.length === 0 || tokens.includes("--%")) return false;
  const command = tokens[0]?.toLowerCase();
  if (!command) return false;
  const args = tokens.slice(1);
  if (READ_ONLY_POWERSHELL_COMMANDS.has(command)) return true;
  if (command === "get-process") return isSafeGetProcessArguments(args);
  if (command === "get-service") return isSafeGetServiceArguments(args);
  if (command !== "git" && command !== "gh") return false;
  return isSafeStructuredCommand(command, args, safeSubcommands, paths);
}

function powerShellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote === "'") {
      if (character !== "'") {
        word += character;
        continue;
      }
      if (segment[index + 1] === "'") {
        word += "'";
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
    } else if (/\s/.test(character)) {
      if (hasWord) words.push(word);
      word = "";
      hasWord = false;
    } else {
      word += character;
      hasWord = true;
    }
  }
  if (quote) return undefined;
  if (hasWord) words.push(word);
  return words;
}

function splitShellSegments(command: string): ShellSegment[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;

  const segments: ShellSegment[] = [];
  let separator: ShellSeparator = "start";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === "$" && trimmed[index + 1] === "(") return undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ">" || character === "<" || character === "(" || character === ")") {
      return undefined;
    }
    const next = trimmed[index + 1];
    if (character === "&" && next !== "&") return undefined;
    const separatorLength =
      character === ";" || character === "|" ? (next === character ? 2 : 1) : character === "&" && next === "&" ? 2 : 0;
    if (separatorLength === 0) continue;
    const segment = trimmed.slice(start, index).trim();
    if (!segment) return undefined;
    segments.push({ text: segment, separator });
    separator = trimmed.slice(index, index + separatorLength) as ShellSeparator;
    index += separatorLength - 1;
    start = index + 1;
  }
  if (quote || escaped) return undefined;
  const finalSegment = trimmed.slice(start).trim();
  if (!finalSegment) return undefined;
  segments.push({ text: finalSegment, separator });
  return segments;
}

function isSafeSegment(
  segment: string,
  safeSubcommands: SafeSubcommands,
  paths: PathPolicy,
  platform: NodeJS.Platform,
) {
  const prefix = matchConfiguredPrefix(segment, safeSubcommands);
  const tokens = shellWords(segment);
  if (!tokens || tokens.length === 0) return false;
  const command = tokens[0]?.toLowerCase();
  if (!command) return false;
  const args = tokens.slice(1);
  // Hardened commands keep their argument checks even when a configured prefix names them.
  if (command === "ssh") return prefix !== undefined && isSafeSshSegment(segment, prefix, safeSubcommands, platform);
  if (command === "curl") return !hasShellExpansion(segment) && isSafeCurlArguments(args);
  if (command === "gh" && args[0]?.toLowerCase() === "api") {
    return !hasShellExpansion(segment) && isSafeGhApiArguments(args.slice(1));
  }
  if (prefix !== undefined) return true;
  if (hasShellExpansion(segment) || /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) {
    return false;
  }
  if (MUTATING_COMMANDS.has(command)) return false;
  if (!hasSafeArguments(command, args)) return false;
  if (command === "hostname") return args.length === 0;
  if (command === "tasklist") return platform === "win32" && isSafeTasklistArguments(args);
  if (READ_ONLY_COMMANDS.has(command)) return true;
  return isSafeStructuredCommand(command, args, safeSubcommands, paths);
}

/**
 * `ssh <host> <command>` needs a configured `ssh <host>` prefix; the remote command must be
 * non-empty, must not start with an ssh option, and is re-validated with the same policy.
 */
function isSafeSshSegment(
  segment: string,
  prefix: string,
  safeSubcommands: SafeSubcommands,
  platform: NodeJS.Platform,
) {
  if (hasShellExpansion(segment)) return false;
  const remainder = segment.trimStart().slice(prefix.length);
  const words = shellWords(remainder);
  if (!words || words.length === 0 || words[0]?.startsWith("-")) return false;
  return findBlockedCommandSegment(words.join(" "), safeSubcommands, undefined, platform, [], true) === undefined;
}

const CURL_FORBIDDEN_LONG = [
  "--output",
  "--remote-name",
  "--remote-name-all",
  "--remote-header-name",
  "--output-dir",
  "--create-dirs",
  "--data",
  "--form",
  "--upload-file",
  "--json",
  "--config",
  "--dump-header",
  "--cookie-jar",
  "--trace",
  "--libcurl",
  "--stderr",
  "--netrc-file",
  "--next",
];
/** Short options that write files, send bodies, upload, or load a config file. */
const CURL_FORBIDDEN_SHORT = new Set(["o", "O", "J", "d", "F", "T", "K", "D", "c"]);
const CURL_VALUE_SHORT = new Set(["A", "b", "e", "E", "H", "m", "u", "w", "x", "y", "Y", "z", "r", "C", "Q", "t"]);

/** GET only, no output files, bodies, uploads, or config files. */
function isSafeCurlArguments(args: string[]) {
  let index = 0;
  const takeNext = () => {
    index += 1;
    return args[index];
  };
  for (; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const name = argument.split("=", 1)[0] ?? "";
    // curl accepts unambiguous abbreviations of long options, so match prefixes too.
    if (argument.startsWith("--") && name.length >= 5 && "--request".startsWith(name)) {
      const method = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : takeNext();
      if (method?.toUpperCase() !== "GET") return false;
    } else if (argument.startsWith("--")) {
      if (CURL_FORBIDDEN_LONG.some((forbidden) => forbidden.startsWith(name) || name.startsWith(`${forbidden}-`))) {
        return false;
      }
    } else if (argument.startsWith("-") && argument.length > 1) {
      for (let position = 1; position < argument.length; position += 1) {
        const flag = argument[position] ?? "";
        if (CURL_FORBIDDEN_SHORT.has(flag)) return false;
        if (flag === "X") {
          const attached = argument.slice(position + 1);
          const method = attached || takeNext();
          if (method?.toUpperCase() !== "GET") return false;
          break;
        }
        // The rest of the cluster (or the next word) is this option's value.
        if (CURL_VALUE_SHORT.has(flag)) {
          if (position === argument.length - 1) index += 1;
          break;
        }
      }
    }
  }
  return true;
}

/** `gh api` is GET only: no `-X`/`--method` other than GET, no body flags, no `graphql`. */
function isSafeGhApiArguments(args: string[]) {
  const isGet = (method: string | undefined) => method?.toUpperCase() === "GET";
  let index = 0;
  const takeNext = () => {
    index += 1;
    return args[index];
  };
  for (; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "graphql") return false;
    if (argument === "--method" || argument.startsWith("--method=")) {
      if (!isGet(argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : takeNext())) return false;
    } else if (argument.startsWith("--")) {
      if (["--field", "--raw-field", "--input"].some((flag) => argument === flag || argument.startsWith(`${flag}=`))) {
        return false;
      }
    } else if (argument.startsWith("-") && argument.length > 1) {
      // Short-flag cluster (`-iXGET`): f/F send a body, X sets the method, H/q/p/t take the rest as a value.
      for (let position = 1; position < argument.length; position += 1) {
        const flag = argument[position];
        if (flag === "f" || flag === "F") return false;
        if (flag === "X") {
          if (!isGet(argument.slice(position + 1) || takeNext())) return false;
          break;
        }
        if ("Hqpt".includes(flag ?? "")) {
          if (position === argument.length - 1) index += 1;
          break;
        }
      }
    }
  }
  return true;
}

function hasShellExpansion(segment: string) {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "$" && quote === '"') return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (["$", "*", "?", "[", "{"].includes(character)) return true;
  }
  return false;
}

function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else word += character;
  }
  if (quote || escaped) return undefined;
  if (word) words.push(word);
  return words;
}

function hasSafeArguments(command: string, args: string[]) {
  const forbidden = new Set(["--in-place", "--fix", "--write", "-delete", "--delete"]);
  if (!INSPECTION_CASE_FLAG_COMMANDS.has(command)) forbidden.add("-i");
  if (args.some((argument) => forbidden.has(argument))) return false;
  if (
    command === "sed" &&
    args.some(
      (argument) => argument.startsWith("--in-place=") || (/^-[^-]+/.test(argument) && argument.slice(1).includes("i")),
    )
  ) {
    return false;
  }
  if (
    command === "find" &&
    args.some((argument) =>
      ["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(argument),
    )
  ) {
    return false;
  }
  if (command === "date" && args.some((argument) => argument === "-s" || argument.startsWith("--set"))) {
    return false;
  }
  if (
    (command === "sort" || command === "tree") &&
    args.some(
      (argument) =>
        argument === "-o" ||
        (argument.startsWith("-o") && !argument.startsWith("--")) ||
        argument.startsWith("--output"),
    )
  ) {
    return false;
  }
  if (
    command === "sort" &&
    args.some(
      (argument) =>
        argument === "-T" ||
        (argument.startsWith("-T") && argument.length > 2) ||
        argument.startsWith("--temporary-directory") ||
        argument.startsWith("--compress-program"),
    )
  ) {
    return false;
  }
  if (command === "diff" && args.some((argument) => argument === "--output" || argument.startsWith("--output="))) {
    return false;
  }
  if (command === "uniq" && args.filter((argument) => !argument.startsWith("-")).length > 1) {
    return false;
  }
  if (
    command === "fd" &&
    args.some((argument) =>
      ["-x", "-X", "--exec", "--exec-batch"].some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
    )
  ) {
    return false;
  }
  if (command === "rg" && args.some((argument) => argument === "--pre" || argument.startsWith("--pre="))) {
    return false;
  }
  if (command === "bat" && args.some((argument) => argument === "--pager" || argument.startsWith("--pager="))) {
    return false;
  }
  return true;
}

type ArgumentValidator = (args: string[]) => boolean;
const allowReadOnlyArguments: ArgumentValidator = () => true;
const BUILTIN_GIT_VALIDATORS: Record<BuiltinSafeGitSubcommand, ArgumentValidator> = {
  status: allowReadOnlyArguments,
  log: allowReadOnlyArguments,
  diff: allowReadOnlyArguments,
  show: allowReadOnlyArguments,
  branch: isSafeGitBranchArguments,
  remote: isSafeGitRemoteArguments,
  "ls-files": allowReadOnlyArguments,
  grep: isSafeGitGrepArguments,
};
const CONFIGURABLE_GIT_VALIDATORS: Record<ConfigurableSafeGitSubcommand, ArgumentValidator> = {
  "rev-parse": allowReadOnlyArguments,
  blame: allowReadOnlyArguments,
  describe: allowReadOnlyArguments,
  "merge-base": allowReadOnlyArguments,
  "ls-tree": allowReadOnlyArguments,
  "cat-file": isSafeGitCatFileArguments,
};
const GH_VALIDATORS: Record<SafeGhSubcommandPath, ArgumentValidator> = {
  "pr view": isSafeGhReadArguments,
  "pr list": isSafeGhReadArguments,
  "issue view": isSafeGhReadArguments,
  "issue list": isSafeGhReadArguments,
};

function isSafeStructuredCommand(command: string, args: string[], safeSubcommands: SafeSubcommands, paths: PathPolicy) {
  if (command === "git") return isSafeGitCommand(args, safeSubcommands, paths);
  if (command === "gh") return isSafeGhCommand(args, safeSubcommands);

  const subcommandIndex = args.findIndex((argument) => !argument.startsWith("-"));
  const subcommand = args[subcommandIndex]?.toLowerCase();
  const subcommandArgs = subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : [];
  if (command === "sed") {
    const script = args.find((argument) => !argument.startsWith("-"));
    return (
      Boolean(script) &&
      (args.includes("-n") || args.some((argument) => /^-[^-]*n[^-]*$/.test(argument))) &&
      /^\d+(,\d+)?p$/.test(script ?? "")
    );
  }
  if (["node", "python", "python3", "tsc", "biome", "ruff", "ty"].includes(command)) {
    if (args.includes("--version")) return true;
    return (
      command === "tsc" &&
      args.includes("--noEmit") &&
      !args.some(
        (argument) =>
          argument === "--incremental" ||
          argument.startsWith("--incremental=") ||
          argument === "--tsBuildInfoFile" ||
          argument.startsWith("--tsBuildInfoFile=") ||
          argument === "--generateTrace" ||
          argument.startsWith("--generateTrace="),
      )
    );
  }
  if (command === "npm") {
    if (subcommand === "audit" && subcommandArgs.includes("fix")) return false;
    if (["list", "ls", "view", "info", "search", "outdated", "audit", "test"].includes(subcommand ?? "")) {
      return true;
    }
    return subcommand === "run" && ["test", "check", "typecheck", "lint"].includes(args[1] ?? "");
  }
  if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
    return ["test", "check"].includes(subcommand ?? "") || ["pytest", "vitest", "jest"].includes(command);
  }
  return false;
}

function isSafeTasklistArguments(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]?.toLowerCase();
    if (["/v", "/nh", "/svc"].includes(argument ?? "")) continue;
    if (argument === "/fo") {
      const format = args[index + 1]?.toLowerCase();
      if (!format || !["table", "list", "csv"].includes(format)) return false;
      index += 1;
      continue;
    }
    if (argument === "/fi") {
      const filter = args[index + 1];
      if (!filter || filter.startsWith("/")) return false;
      index += 1;
      continue;
    }
    if (argument === "/m") {
      const module = args[index + 1];
      if (module && !module.startsWith("/")) index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isSafeGetProcessArguments(args: string[]) {
  return hasSafePowerShellQueryArguments(
    args,
    new Set(["-module", "-fileversioninfo", "-includeusername"]),
    new Set(["-name", "-id"]),
  );
}

function isSafeGetServiceArguments(args: string[]) {
  return hasSafePowerShellQueryArguments(
    args,
    new Set(["-dependentservices", "-requiredservices"]),
    new Set(["-name", "-displayname", "-include", "-exclude"]),
  );
}

function hasSafePowerShellQueryArguments(
  args: string[],
  switches: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
) {
  let positionalValues = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const normalized = argument?.toLowerCase();
    if (!argument || !normalized) return false;
    if (!argument.startsWith("-")) {
      positionalValues += 1;
      if (positionalValues > 1) return false;
      continue;
    }
    if (switches.has(normalized)) continue;
    if (!valueOptions.has(normalized)) return false;
    const value = args[index + 1];
    if (!value || value.startsWith("-")) return false;
    index += 1;
  }
  return true;
}

function isSafeGitCommand(args: string[], safeSubcommands: SafeSubcommands, paths: PathPolicy) {
  const subcommandIndex = parseGitGlobalOptions(args, paths);
  if (subcommandIndex === undefined) return false;
  const subcommand = args[subcommandIndex]?.toLowerCase();
  if (!subcommand || subcommand.startsWith("-")) return false;
  const subcommandArgs = args.slice(subcommandIndex + 1);
  const builtinValidator = (BUILTIN_GIT_VALIDATORS as Record<string, ArgumentValidator>)[subcommand];
  const configuredValidator = (CONFIGURABLE_GIT_VALIDATORS as Record<string, ArgumentValidator>)[subcommand];
  const configured = safeSubcommands.git?.includes(subcommand as SafeGitSubcommand) === true;
  const validator = builtinValidator ?? (configured ? configuredValidator : undefined);
  return validator !== undefined && hasSafeGitArguments(subcommand, subcommandArgs) && validator(subcommandArgs);
}

function parseGitGlobalOptions(args: string[], paths: PathPolicy) {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--no-pager") {
      index += 1;
      continue;
    }
    if (argument !== "-C") break;
    if (resolveDirectory(args[index + 1], paths.base, paths.roots) === undefined) return undefined;
    index += 2;
  }
  return index;
}

function hasSafeGitArguments(subcommand: string, args: string[]) {
  return !args.some(
    (argument) =>
      argument === "--help" ||
      argument === "--show-signature" ||
      argument.startsWith("--show-signature=") ||
      argument.includes("%G") ||
      argument === "--output" ||
      argument.startsWith("--output=") ||
      argument === "--ext-diff" ||
      argument.startsWith("--ext-diff=") ||
      argument === "--textconv" ||
      argument.startsWith("--textconv=") ||
      argument === "--paginate" ||
      argument === "--open-files-in-pager" ||
      argument.startsWith("--open-files-in-pager=") ||
      (subcommand === "grep" && (argument === "-O" || argument.startsWith("-O"))),
  );
}

function isSafeGitCatFileArguments(args: string[]) {
  return !args.some(
    (argument) =>
      matchesLongOptionPrefix(argument, "--filters", "--fi") || matchesLongOptionPrefix(argument, "--textconv", "--t"),
  );
}

function isSafeGitGrepArguments(args: string[]) {
  return !args.some(
    (argument) =>
      matchesLongOptionPrefix(argument, "--textconv", "--textc") ||
      matchesLongOptionPrefix(argument, "--open-files-in-pager", "--op") ||
      matchesLongOptionPrefix(argument, "--ext-grep", "--ext"),
  );
}

function matchesLongOptionPrefix(argument: string, option: string, shortest: string) {
  const optionName = argument.split("=", 1)[0] ?? "";
  return optionName.length >= shortest.length && option.startsWith(optionName);
}

function isSafeGitBranchArguments(args: string[]) {
  if (args.some((argument) => !argument.startsWith("-"))) return false;
  return !args.some(
    (argument) =>
      /^-[^-]*[dDmMcCu]/.test(argument) ||
      matchesLongOptionPrefix(argument, "--delete", "--del") ||
      matchesLongOptionPrefix(argument, "--move", "--mov") ||
      matchesLongOptionPrefix(argument, "--copy", "--cop") ||
      matchesLongOptionPrefix(argument, "--edit-description", "--e") ||
      matchesLongOptionPrefix(argument, "--unset-upstream", "--u") ||
      matchesLongOptionPrefix(argument, "--set-upstream-to", "--set-u") ||
      matchesLongOptionPrefix(argument, "--create-reflog", "--creat"),
  );
}

function isSafeGitRemoteArguments(args: string[]) {
  const actionIndex = args.findIndex((argument) => !argument.startsWith("-"));
  if (actionIndex < 0) return true;
  const action = args[actionIndex];
  if (action === "get-url") return true;
  if (action !== "show") return false;

  const showArgs = args.slice(actionIndex + 1);
  if (showArgs.includes("--")) return false;
  const remotes = showArgs.filter((argument) => !argument.startsWith("-"));
  return remotes.length === 0 || (remotes.length === 1 && showArgs.includes("-n"));
}

function isSafeGhCommand(args: string[], safeSubcommands: SafeSubcommands) {
  const group = args[0]?.toLowerCase();
  const action = args[1]?.toLowerCase();
  if (!group || !action || group.startsWith("-") || action.startsWith("-")) return false;
  const path = `${group} ${action}` as SafeGhSubcommandPath;
  if (!safeSubcommands.gh?.includes(path)) return false;
  const validator = (GH_VALIDATORS as Record<string, ArgumentValidator>)[path];
  return validator?.(args.slice(2)) ?? false;
}

function isSafeGhReadArguments(args: string[]) {
  return !args.some(isUnsafeGhReadArgument) && hasGhJsonOutput(args);
}

function isUnsafeGhReadArgument(argument: string) {
  return (
    argument.startsWith("-w") ||
    argument === "--web" ||
    argument.startsWith("--web=") ||
    argument === "--browser" ||
    argument.startsWith("--browser=") ||
    argument === "--paginate" ||
    argument === "--pager" ||
    argument.startsWith("--pager=") ||
    argument === "--output" ||
    argument.startsWith("--output=")
  );
}

function hasGhJsonOutput(args: string[]) {
  let hasJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return false;
      hasJson = true;
      index += 1;
    } else if (argument.startsWith("--json=")) {
      if (argument === "--json=") return false;
      hasJson = true;
    }
  }
  return hasJson;
}
