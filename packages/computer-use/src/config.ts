import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ComputerUseConfig {
	browser_use: boolean;
	headless: boolean;
	cursor_overlay: boolean;
	/** Whole-desktop screenshot and physical input tools (macOS). Ignored while `headless` is true. */
	desktop_control: boolean;
	activity_glow: boolean;
	managed_browser: "helium" | "chrome";
	/** Dedicated credential-bearing profile. Only the user-global file may opt in. */
	managed_browser_profile: string | null;
	/** Bundle ids `act_ui`, `desktop_input` and `observe_ui` refuse (`app_blocked`), on top of `ALWAYS_BLOCKED_BUNDLE_IDS`. */
	blocked_apps: string[];
}

/** Password managers, credential UIs and terminals blocked unless `blocked_apps` replaces the list. */
export const DEFAULT_BLOCKED_APPS: readonly string[] = [
	"com.apple.keychainaccess",
	"com.apple.Passwords",
	"com.1password.1password",
	"com.1password.1password7",
	"com.agilebits.onepassword7",
	"com.agilebits.onepassword-osx-helper",
	"com.bitwarden.desktop",
	"com.lastpass.LastPass",
	"com.dashlane.dashlanephonefinal",
	"org.keepassxc.keepassxc",
	"com.apple.Terminal",
	"com.googlecode.iterm2",
	"net.kovidgoyal.kitty",
	"com.mitchellh.ghostty",
	"dev.warp.Warp-Stable",
	"co.zeit.hyper",
	"org.alacritty",
	"com.github.wez.wezterm",
];

/** System authentication agents. Never removable through `blocked_apps`; mirrored by `alwaysBlockedBundleIds` in `bridge.swift`. */
export const ALWAYS_BLOCKED_BUNDLE_IDS: readonly string[] = [
	"com.apple.SecurityAgent",
	"com.apple.loginwindow",
	"com.apple.coreservices.uiagent",
	"com.apple.ScreenSaver.Engine",
];

export interface ComputerUseConfigSource {
	path: string;
	exists: boolean;
	values?: Partial<ComputerUseConfig>;
	error?: string;
	/** `blocked_apps` from a project file: ids that are only ever ADDED to the effective list. */
	blockedAppsAdd?: string[];
}

export interface LoadedComputerUseConfig {
	config: ComputerUseConfig;
	sources: ComputerUseConfigSource[];
	env: Partial<ComputerUseConfig>;
	/** Rejected `blocked_apps` input (the defaults stay in force for it); shown by `/computer-use`. */
	blockedAppsErrors: string[];
}

const DEFAULT_CONFIG: ComputerUseConfig = {
	browser_use: true,
	headless: false,
	cursor_overlay: true,
	desktop_control: true,
	activity_glow: false,
	managed_browser: "chrome",
	managed_browser_profile: null,
	blocked_apps: [...DEFAULT_BLOCKED_APPS],
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {}, blockedAppsErrors: [] };

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

type BundleIds = { ids: string[] } | { error: string };

/** A JSON array of non-blank bundle id strings. Any other shape or entry is rejected whole, never filtered. */
function parseBundleIdArray(value: unknown): BundleIds {
	if (!Array.isArray(value)) return { error: "blocked_apps must be an array of bundle id strings" };
	const bad = value.filter((item) => typeof item !== "string" || !item.trim());
	if (bad.length) return { error: `blocked_apps has ${bad.length} invalid entr${bad.length === 1 ? "y" : "ies"} (each must be a non-blank string)` };
	return { ids: [...new Set((value as string[]).map((item) => item.trim()))] };
}

/** `PI_COMPUTER_USE_BLOCKED_APPS`: a comma list of ids to ADD to the blocklist; blank is unset. The env can never remove an id (a repo's `.envrc` can set it). */
function parseBundleIdEnv(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function normalizePartial(raw: unknown): Partial<ComputerUseConfig> {
	if (!raw || typeof raw !== "object") return {};
	const source = (raw as any).computer_use && typeof (raw as any).computer_use === "object" ? (raw as any).computer_use : raw;
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean((source as any).browser_use);
	const headless = parseBoolean((source as any).headless);
	const cursorOverlay = parseBoolean((source as any).cursor_overlay);
	const activityGlow = parseBoolean((source as any).activity_glow);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	const desktopControl = parseBoolean((source as any).desktop_control);
	if (desktopControl !== undefined) out.desktop_control = desktopControl;
	if (activityGlow !== undefined) out.activity_glow = activityGlow;
	const managedBrowser = (source as any).managed_browser;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	return out;
}

/** The raw `blocked_apps` value of a parsed config file, or undefined when absent. */
function rawBlockedApps(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return undefined;
	const source = (raw as any).computer_use && typeof (raw as any).computer_use === "object" ? (raw as any).computer_use : raw;
	return (source as any).blocked_apps;
}

function readConfigFile(filePath: string, scope: "user" | "project"): ComputerUseConfigSource & { blockedAppsError?: string } {
	if (!existsSync(filePath)) return { path: filePath, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		const out: ComputerUseConfigSource & { blockedAppsError?: string } = { path: filePath, exists: true, values: normalizePartial(parsed) };
		// Never let a repository opt into a credential-bearing profile.
		const profile = parsed?.computer_use?.managed_browser_profile ?? parsed?.managed_browser_profile;
		if (scope === "user" && typeof profile === "string" && profile.trim()) out.values = { ...out.values, managed_browser_profile: profile.trim() };
		const rawList = rawBlockedApps(parsed);
		if (rawList !== undefined) {
			const result = parseBundleIdArray(rawList);
			if ("error" in result) out.blockedAppsError = `${filePath}: ${result.error}; keeping the current list`;
			// Only the user-global file may replace (or empty) the list; a project file, which a repo or an agent can write, only adds.
			else if (scope === "user") out.values = { ...out.values, blocked_apps: result.ids };
			else out.blockedAppsAdd = result.ids;
		}
		return out;
	} catch (error) {
		return { path: filePath, exists: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function readEnv(): Partial<ComputerUseConfig> {
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
	const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
	const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
	const activityGlow = parseBoolean(process.env.PI_COMPUTER_USE_ACTIVITY_GLOW);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	const desktopControl = parseBoolean(process.env.PI_COMPUTER_USE_DESKTOP_CONTROL);
	if (desktopControl !== undefined) out.desktop_control = desktopControl;
	if (activityGlow !== undefined) out.activity_glow = activityGlow;
	const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	return out;
}

export function loadComputerUseConfig(cwd: string): LoadedComputerUseConfig {
	const read = [
		readConfigFile(path.join(getAgentDir(), "extensions", "pi-computer-use.json"), "user"),
		readConfigFile(path.join(cwd, ".pi", "computer-use.json"), "project"),
	];
	const blockedAppsErrors = read.flatMap((source) => (source.blockedAppsError ? [source.blockedAppsError] : []));
	const sources: ComputerUseConfigSource[] = read.map(({ blockedAppsError: _ignored, ...source }) => source);
	const env = readEnv();
	const config = { ...DEFAULT_CONFIG, blocked_apps: [...DEFAULT_BLOCKED_APPS] };
	for (const source of sources) {
		if (source.values) Object.assign(config, source.values);
	}
	Object.assign(config, env);
	// Project files and the environment, both repo-controllable, can only add ids.
	config.blocked_apps = [...new Set([...config.blocked_apps, ...sources.flatMap((source) => source.blockedAppsAdd ?? []), ...parseBundleIdEnv(process.env.PI_COMPUTER_USE_BLOCKED_APPS)])];
	activeConfig = config;
	activeLoadedConfig = { config, sources, env, blockedAppsErrors };
	return activeLoadedConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
	return activeConfig;
}

export function getLoadedComputerUseConfig(): LoadedComputerUseConfig {
	return activeLoadedConfig;
}

export function isHeadlessMode(): boolean {
	return activeConfig.headless;
}

/** Every bundle id the policy blocks: the always-blocked system agents plus the configured `blocked_apps`. */
export function effectiveBlockedBundleIds(): string[] {
	return [...new Set([...ALWAYS_BLOCKED_BUNDLE_IDS, ...activeConfig.blocked_apps])];
}

/** True when `bundleId` (case-insensitive) is blocked; an app without a bundle id can never match. */
export function isBlockedBundleId(bundleId: string | undefined): boolean {
	if (!bundleId) return false;
	const wanted = bundleId.toLowerCase();
	return effectiveBlockedBundleIds().some((blocked) => blocked.toLowerCase() === wanted);
}

export function isBrowserUseEnabled(): boolean {
	return activeConfig.browser_use;
}

/*
PI_DOCS_REFERENCE_BEGIN reference/configuration

Configuration controls browser access, blocked apps, strict accessibility execution, the macOS agent cursor, and the macOS activity glow.

## Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project config:

```text
.pi/computer-use.json
```

Project config overrides global config, except `blocked_apps`, which a project file can only add to. Environment variables override both.

Example:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "activity_glow": true,
  "blocked_apps": ["com.apple.Terminal", "com.1password.1password"]
}
```

Run `/computer-use` in Pi to show the active config and its source.

## Options

### `browser_use`

Default: `{{config-default:browser_use}}`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `managed_browser`

Default: `{{config-default:managed_browser}}`

Selects `"helium"` or `"chrome"` for `launch_browser`. The debugging port is always allocated internally and isn't part of the model-facing contract.

### `managed_browser_profile`

Default: `null` (fresh temporary profile for every launch).

Only the **user-global** config may set this option; project config cannot opt into or redirect a credential-bearing profile. Set an absolute path (or `~/...`) to a dedicated, pre-created directory outside every Git checkout. On POSIX it must be owned by the current user with mode `0700`, not a symlink (including ancestor components), and not a browser's default data directory, its ancestors or descendants. Use a canonical path if the home directory is an alias. For example, create `~/.pi/computer-use-profile` with `mkdir -m 700 ~/.pi/computer-use-profile`, then set `"managed_browser_profile": "~/.pi/computer-use-profile"` in the global file. Native Windows persistent profiles are refused because POSIX modes do not establish an owner-only Windows ACL; temporary profiles remain available.

This directory holds **live credentials**, cookies and browsing history. Never commit, sync or share it. A user may sign in manually once, with separate explicit consent, then later launches reuse that dedicated profile. Pi does not import an existing personal browser profile, inspect credentials, or perform login automatically. Close other browsers using the directory before launch. Pi acquires an atomic `.pi-computer-use.lock` directory and refuses existing Pi leases or Chromium `SingletonLock`, `SingletonCookie` or `SingletonSocket` entries, including dangling symlinks. It never removes Chromium locks or steals a stale lease. Normal shutdown and failed launches stop the browser and release Pi's lease, but never delete this profile. A hard Pi exit kills the browser and leaves the lease fail-closed; a host crash may also leave Chromium locks. Verify that every process using this dedicated profile has stopped before manually resolving stale locks (`rmdir <profile>/.pi-computer-use.lock` for an empty Pi lease). Chromium's own lock is the final arbitration with browsers launched outside Pi. Remove it manually to revoke local reuse; server-side sessions may need separate revocation. This is a guard against mistakes, not isolation from other processes running as the same user.

### `headless`

Default: `{{config-default:headless}}`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, the agent cursor overlay, and the activity glow are blocked. On macOS, actions that would need synthesized pointer or keyboard input, including every `typeText`, `paste` and `keypress`, fail with `foreground_required` ([macOS reference](./platforms/macos/actions.mdx#headless-policy)). When `false` (the default), Pi prefers verified semantic activation when it is credible, preserves the focus established by editable clicks for dependent keyboard input, and may retry keyboard input in the foreground when a background attempt conclusively produced no value change. Ambiguous pointer actions are never replayed blindly.

### `cursor_overlay`

Default: `{{config-default:cursor_overlay}}`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting ([macOS reference](./platforms/macos/actions.mdx#agent-cursor-overlay)).

### `activity_glow`

Default: `{{config-default:activity_glow}}`

When `true`, macOS displays a click-through pulsing border on every screen while a Pi agent is using one of the extension's tools. The border stays visible until the agent run ends. Each Pi session owns its indicator state, so one session cannot hide another session's active indicator. The helper removes a session's state if its connection closes unexpectedly.

The activity glow appears in user screen recordings. Single-window `observe_ui` captures exclude screen-edge overlays, but whole-display `desktop_screenshot` captures exclude only blocked apps and can include an already-active glow. Desktop tools do not activate the glow themselves; another tool or session may already have activated it. The glow is excluded from accessibility discovery. Other platforms ignore this setting, and `headless: true` always suppresses it ([macOS reference](./platforms/macos/implementation.mdx#activity-glow)).

### `blocked_apps`

Default: the list below. System authentication agents are blocked in addition, always.

A list of macOS bundle ids that Pi refuses to observe or control. The default list covers password managers (`com.apple.Passwords`, `com.1password.1password`, `com.1password.1password7`, `com.agilebits.onepassword7`, `com.agilebits.onepassword-osx-helper`, `com.bitwarden.desktop`, `com.lastpass.LastPass`, `com.dashlane.dashlanephonefinal`, `org.keepassxc.keepassxc`), Keychain Access (`com.apple.keychainaccess`) and terminals (`com.apple.Terminal`, `com.googlecode.iterm2`, `net.kovidgoyal.kitty`, `com.mitchellh.ghostty`, `dev.warp.Warp-Stable`, `co.zeit.hyper`, `org.alacritty`, `com.github.wez.wezterm`).

The system authentication agents `com.apple.SecurityAgent`, `com.apple.loginwindow`, `com.apple.coreservices.uiagent` and `com.apple.ScreenSaver.Engine` are always blocked and cannot be removed by this option.

A blocked target fails with the coded error `app_blocked`. `act_ui` coordinate input and HID typing are checked more narrowly than `desktop_input`:

- `observe_ui`, `act_ui` and every tool that resolves a root (e.g. `read_text`, `wait_for`) refuse a root owned by a blocked app. `act_ui` re-checks on every call, so adding an app to the list stops a state observed earlier.
- `desktop_input` refuses `activateApp` of a blocked app, refuses `typeText` and `keypress` while a blocked app is frontmost or holds key focus, and refuses `moveMouse`, `click`, `scroll` and `drag` whose pointer (or any drag path vertex) lands on a blocked app's window. The helper checks immediately before it delivers the input, but a key sequence that itself switches apps (e.g. `cmd+tab`) or a focus change in the middle of delivery is not re-checked, so this is a guard against mistakes, not a sandbox. Clipboard actions are not input delivery and are not blocked.
- `act_ui` re-resolves and checks the target app for every action, so `secondaryAction` and `selectText` (AX-only) cannot reach a blocked app either. `act_ui` with HID delivery refuses a coordinate `click`, `moveMouse`, `scroll` or `drag` whose point (or any drag vertex) lands on a blocked app's window, after it has focused the target and run its occlusion preflight and right before it posts the event, so a blocked window that the target's own focus change uncovers is not a false refusal. Pid (background) delivery skips this pointer check: it targets one app and that app's root is already checked. HID `typeText`, `paste`, `keypress` and the web-content `setText` fallback (which types through `cmd+a` and keystrokes) wait up to 200 ms of wall time for the target to become frontmost and focused, then refuse a blocked focused app; if the target never takes focus the call fails with `focus_not_acquired`. With `preserveFocus` the focus is not moved or awaited and the current focus is checked at once.
- `find_roots` still lists blocked roots, marked `blocked`, so the model learns why they cannot be used.

Only the user-global file can replace the list. A project `.pi/computer-use.json` is writable by the repository and by the agent itself, so its `blocked_apps` is only unioned into the effective list: it can add ids, never remove one, and `[]` there changes nothing. The environment is treated the same way, because a repository can set it too (`.envrc`, direnv, a launch script). The user-global list replaces the default, it does not extend it, so the explicit opt-out is a literal `"blocked_apps": []` in `~/.pi/agent/extensions/pi-computer-use.json`; copy the defaults and append to extend them.

A `blocked_apps` value that is not an array of non-blank strings (e.g. `[{"id": "..."}]`, `[123]`, `[" "]`) is a configuration error, not an opt-out: the previous list stays in force and `/computer-use` prints the error. Bundle ids compare case-insensitively. A root without a bundle id (e.g. an unbundled process) cannot be matched. The environment variable `PI_COMPUTER_USE_BLOCKED_APPS` takes a comma-separated list of ids that are added to the effective list; it never removes one, a blank value (empty, whitespace, only commas) is treated as unset, and there is no environment opt-out (`none` is just an id that matches nothing). Trust model: the environment and project config are additive only; the user-global file is the only place that can opt out, and `PI_CODING_AGENT_DIR` selects which file that is, so it must be controlled by the operator, not by a repository.

Known limits. This is a guard against mistakes, not a sandbox:

- Terminals embedded in an IDE (e.g. VS Code, JetBrains) belong to the IDE's bundle id, so they are not blocked unless you add the IDE.
- Password managers that run inside a browser (extensions, web vaults) belong to the browser's bundle id and are not blocked. Add the browser, or set `browser_use` to `false`.
- The clipboard is not guarded: `desktop_input` `readClipboard` and `writeClipboard` work regardless of the list, and secrets copied from a blocked app stay readable.
- Outlines cached by an earlier `observe_ui` (`search_ui`, `expand_ui`, `inspect_ui` read the stored state) are not re-checked against a list that grew afterwards; `act_ui` and `read_text` are.
- Pointer input is checked against the window list and an accessibility hit test immediately before delivery; a window that appears or moves in the middle of delivery is not re-checked.

### Locked sessions

While the macOS session is locked (`CGSSessionScreenIsLocked`, or a session that is no longer on the console after a fast user switch) the helper refuses every command that reads or drives the UI (`look`, `act`, `actBatch`, `hitTest`, `axWaitFor`, `axReadText`, `focusedElement`, `focusWindow`, `setWindowFrame`, `captureDisplay`, `desktopInput`) with the coded error `screen_locked`. Discovery (`find_roots`) keeps working. This is not configurable.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_MANAGED_BROWSER=helium
PI_COMPUTER_USE_MANAGED_BROWSER=chrome
PI_COMPUTER_USE_CHROME_EXECUTABLE=/absolute/path/to/chrome
PI_COMPUTER_USE_HELIUM_EXECUTABLE=/absolute/path/to/helium
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_ACTIVITY_GLOW=0
PI_COMPUTER_USE_ACTIVITY_GLOW=1
PI_COMPUTER_USE_BLOCKED_APPS=com.apple.Terminal,com.example.Vault
PI_COMPUTER_USE_CDP_PORT=9222
PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS=0
PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS=1
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback.

`launch_browser` searches common platform install locations and `PATH`. Use `PI_COMPUTER_USE_CHROME_EXECUTABLE` or `PI_COMPUTER_USE_HELIUM_EXECUTABLE` for an AppImage, portable install, or any non-standard location (including a `/mnt/c/.../chrome.exe` WSL override). An explicit override is authoritative and must name an executable file. Launch results include the selected executable. A WSL Windows executable override does not guarantee Windows/WSL CDP networking or path translation; an unreachable loopback endpoint fails launch and is cleaned up, never falls back to a personal browser.

On Linux, `launch_browser` launches the managed browser headless (`--headless=new --disable-gpu`, plus `--no-sandbox` when running as root) when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, since there is no graphical session for a visible window. Set `PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS` to `0` or `1` to force the decision explicitly on any platform; without it macOS and Windows always run windowed, since they always have a desktop session.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

Use a dedicated, non-default profile with `--user-data-dir=<directory>`. Chrome 136 and later ignore remote-debugging switches for the default data directory as a security measure. Unless `managed_browser_profile` is explicitly configured in the user-global file, `launch_browser` creates a private temporary CDP profile for each launch (a fresh owner-only directory under the system temp dir, removed when the browser exits or Pi quits) and binds discovery to a randomly allocated loopback port. An aborted launch waiting behind another managed-browser lifecycle step does not start a browser. Session shutdown waits for admitted launches to enter that lifecycle and stops their managed browser.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state plus the executable path used. Browser observations flag an `authentication_required` warning for obvious login titles, login URL paths or visible password fields. This heuristic can miss custom/embedded login flows and can flag public login pages; it does not prove authentication success or authorize entering credentials. CDP tools work without AT-SPI; native Linux desktop discovery and interaction still require the graphical user's AT-SPI2 session. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.
PI_DOCS_REFERENCE_END
*/
