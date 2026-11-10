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
}

export interface LoadedComputerUseConfig {
	config: ComputerUseConfig;
	sources: ComputerUseConfigSource[];
	env: Partial<ComputerUseConfig>;
}

const DEFAULT_CONFIG: ComputerUseConfig = {
	browser_use: true,
	headless: false,
	cursor_overlay: true,
	desktop_control: true,
	activity_glow: false,
	managed_browser: "chrome",
	blocked_apps: [...DEFAULT_BLOCKED_APPS],
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {} };

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

/** A list of bundle ids from JSON (array) or the env var (comma-separated); anything else is ignored. */
function parseBundleIds(value: unknown): string[] | undefined {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!items) return undefined;
	return [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
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
	const blockedApps = parseBundleIds((source as any).blocked_apps);
	if (blockedApps) out.blocked_apps = blockedApps;
	return out;
}

function readConfigFile(filePath: string): ComputerUseConfigSource {
	if (!existsSync(filePath)) return { path: filePath, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		return { path: filePath, exists: true, values: normalizePartial(parsed) };
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
	const blockedApps = parseBundleIds(process.env.PI_COMPUTER_USE_BLOCKED_APPS);
	if (blockedApps) out.blocked_apps = blockedApps;
	return out;
}

export function loadComputerUseConfig(cwd: string): LoadedComputerUseConfig {
	const sources = [
		readConfigFile(path.join(getAgentDir(), "extensions", "pi-computer-use.json")),
		readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
	];
	const env = readEnv();
	const config = { ...DEFAULT_CONFIG };
	for (const source of sources) {
		if (source.values) Object.assign(config, source.values);
	}
	Object.assign(config, env);
	activeConfig = config;
	activeLoadedConfig = { config, sources, env };
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

Project config overrides global config. Environment variables override both.

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

### `headless`

Default: `{{config-default:headless}}`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, the agent cursor overlay, and the activity glow are blocked. On macOS, actions that would need synthesized pointer or keyboard input, including every `typeText` and `keypress`, fail with `foreground_required` ([macOS reference](./platforms/macos/actions.mdx#headless-policy)). When `false` (the default), Pi prefers verified semantic activation when it is credible, preserves the focus established by editable clicks for dependent keyboard input, and may retry keyboard input in the foreground when a background attempt conclusively produced no value change. Ambiguous pointer actions are never replayed blindly.

### `cursor_overlay`

Default: `{{config-default:cursor_overlay}}`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting ([macOS reference](./platforms/macos/actions.mdx#agent-cursor-overlay)).

### `activity_glow`

Default: `{{config-default:activity_glow}}`

When `true`, macOS displays a click-through pulsing border on every screen while a Pi agent is using one of the extension's tools. The border stays visible until the agent run ends. Each Pi session owns its indicator state, so one session cannot hide another session's active indicator. The helper removes a session's state if its connection closes unexpectedly.

The activity glow appears in user screen recordings. Single-window `observe_ui` captures exclude screen-edge overlays, but whole-display `desktop_screenshot` captures exclude no windows and can include an already-active glow. Desktop tools do not activate the glow themselves; another tool or session may already have activated it. The glow is excluded from accessibility discovery. Other platforms ignore this setting, and `headless: true` always suppresses it ([macOS reference](./platforms/macos/implementation.mdx#activity-glow)).

### `blocked_apps`

Default: the list below. System authentication agents are blocked in addition, always.

A list of macOS bundle ids that Pi refuses to observe or control. The default list covers password managers (`com.apple.Passwords`, `com.1password.1password`, `com.1password.1password7`, `com.agilebits.onepassword7`, `com.agilebits.onepassword-osx-helper`, `com.bitwarden.desktop`, `com.lastpass.LastPass`, `com.dashlane.dashlanephonefinal`, `org.keepassxc.keepassxc`), Keychain Access (`com.apple.keychainaccess`) and terminals (`com.apple.Terminal`, `com.googlecode.iterm2`, `net.kovidgoyal.kitty`, `com.mitchellh.ghostty`, `dev.warp.Warp-Stable`, `co.zeit.hyper`, `org.alacritty`, `com.github.wez.wezterm`).

The system authentication agents `com.apple.SecurityAgent`, `com.apple.loginwindow`, `com.apple.coreservices.uiagent` and `com.apple.ScreenSaver.Engine` are always blocked and cannot be removed by this option.

A blocked target fails with the coded error `app_blocked`:

- `observe_ui`, `act_ui` and every tool that resolves a root (e.g. `read_text`, `wait_for`) refuse a root owned by a blocked app. `act_ui` re-checks on every call, so adding an app to the list stops a state observed earlier.
- `desktop_input` refuses `activateApp` of a blocked app, refuses `typeText` and `keypress` while a blocked app is frontmost, and refuses `moveMouse`, `click`, `scroll` and `drag` whose pointer (or drag endpoint) lands on a blocked app's window. The helper checks immediately before it delivers the input, but a key sequence that itself switches apps (e.g. `cmd+tab`) or a focus change in the middle of delivery is not re-checked, so this is a guard against mistakes, not a sandbox. Clipboard actions are not input delivery and are not blocked.
- `find_roots` still lists blocked roots, marked `blocked`, so the model learns why they cannot be used.

The list replaces the default, it does not extend it, so an explicit opt-out is `"blocked_apps": []`; copy the defaults and append to extend them. Bundle ids compare case-insensitively. A root without a bundle id (e.g. an unbundled process) cannot be matched. The environment variable `PI_COMPUTER_USE_BLOCKED_APPS` takes a comma-separated list and overrides the files; set it to the empty string to opt out.

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
PI_COMPUTER_USE_BLOCKED_APPS=
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS=0
PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS=1
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a debugging input; normal policy belongs in configuration rather than individual model calls.

`launch_browser` searches common platform install locations and `PATH`. Use `PI_COMPUTER_USE_CHROME_EXECUTABLE` or `PI_COMPUTER_USE_HELIUM_EXECUTABLE` for an AppImage, portable install, or any non-standard location. An explicit override is authoritative and must name an executable file.

On Linux, `launch_browser` launches the managed browser headless (`--headless=new --disable-gpu`, plus `--no-sandbox` when running as root) when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, since there is no graphical session for a visible window. Set `PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS` to `0` or `1` to force the decision explicitly on any platform; without it macOS and Windows always run windowed, since they always have a desktop session.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

Use a dedicated, non-default profile with `--user-data-dir=<directory>`. Chrome 136 and later ignore remote-debugging switches for the default data directory as a security measure. `launch_browser` already creates a private temporary CDP profile for each launch (a fresh owner-only directory under the system temp dir, removed when the browser exits or Pi quits) and binds discovery to a randomly allocated loopback port. An aborted launch waiting behind another managed-browser lifecycle step does not start a browser. Session shutdown waits for admitted launches to enter that lifecycle and stops their managed browser.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.
PI_DOCS_REFERENCE_END
*/
