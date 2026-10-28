/** Normalize explicit settings paths before Pi's real package manager resolves them. */
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { normalizeHomePath } from "./home-paths.js";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ResourceSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

/** Keep filter modifiers and non-home paths intact; only replace leading home references. */
function expandSetting(entry: string, homeDir: string, modifiers = true): string {
  const prefix = modifiers && /^[!+-]/.test(entry) ? entry[0] : "";
  const path = entry.slice(prefix.length);
  const trimmed = path.trim();
  if (trimmed !== "~" && !trimmed.startsWith("~/") && !(process.platform === "win32" && trimmed.startsWith("~\\"))) return entry;
  return prefix + normalizeHomePath(trimmed, homeDir);
}

/** Return copies so loading resources never changes persisted settings or their source objects. */
export function normalizeResourceSettings(settings: ResourceSettings, homeDir: string): ResourceSettings {
  const normalized = { ...settings };
  for (const field of RESOURCE_FIELDS) {
    if (settings[field]) normalized[field] = settings[field].map(entry => expandSetting(entry, homeDir));
  }
  if (settings.packages) {
    normalized.packages = settings.packages.map(pkg => {
      if (typeof pkg === "string") return expandSetting(pkg, homeDir, false);
      const copy = { ...pkg, source: expandSetting(pkg.source, homeDir, false) };
      for (const field of RESOURCE_FIELDS) {
        if (pkg[field]) copy[field] = pkg[field].map(entry => expandSetting(entry, homeDir));
      }
      return copy;
    });
  }
  return normalized;
}

/** Use the real loader/manager while preventing ambient-home expansion of explicit settings. */
export function createHomeResourceLoader(options: ResourceLoaderOptions, homeDir?: string): DefaultResourceLoader {
  if (homeDir === undefined) return new DefaultResourceLoader(options);
  const settingsManager = options.settingsManager ?? SettingsManager.create(options.cwd, options.agentDir);
  const globalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const projectSettings = settingsManager.getProjectSettings.bind(settingsManager);
  // Wrap the public readers, not a cached snapshot: reload and project-trust
  // decisions continue to be owned by Pi, and every read receives fresh copies.
  Object.assign(settingsManager, {
    getGlobalSettings: () => normalizeResourceSettings(globalSettings(), homeDir),
    getProjectSettings: () => normalizeResourceSettings(projectSettings(), homeDir),
  });
  return new DefaultResourceLoader({ ...options, settingsManager });
}
