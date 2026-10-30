/** Resolve named preloaded skills through Pi's configured resource discovery. */

import { type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkills, type ResolvedResource, SettingsManager, type SettingsManager as SettingsManagerType } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.js";
import { createHomePackageManager } from "./resource-loader.js";

/** Discovery is inspect-only: missing sources are never installed or activated. */
const skipMissingSource = async (): Promise<"skip"> => "skip";

export interface PreloadedSkill {
  name: string;
  content: string;
}

export interface SkillPreloadOptions {
  agentDir: string;
  settingsManager: SettingsManagerType;
  homeDir?: string;
}

/**
 * Load named skills through Pi, retaining the preloader's legacy user roots.
 *
 * Pi owns configured package discovery, parsing, trust, and missing-package
 * handling. A second untrusted manager exposes the user/package candidates
 * which Pi's realpath collapse can hide behind a rejected project symlink.
 */
export async function preloadSkills(
  skillNames: string[],
  cwd: string,
  options: SkillPreloadOptions,
): Promise<PreloadedSkill[]> {
  const primary = createHomePackageManager({ cwd, agentDir: options.agentDir, settingsManager: options.settingsManager }, options.homeDir);
  const primaryResources = await primary.resolve(skipMissingSource);
  const fallbackSettings = SettingsManager.create(cwd, options.agentDir, { projectTrusted: false });
  const fallback = createHomePackageManager({ cwd, agentDir: options.agentDir, settingsManager: fallbackSettings }, options.homeDir);
  const fallbackResources = await fallback.resolve(skipMissingSource);

  const rejectedProjectPaths = new Set(primaryResources.skills
    .filter(resource => resource.metadata.origin === "top-level" && resource.metadata.scope === "project" && isSymlinkedProjectSkill(resource, cwd))
    .map(resource => canonicalPath(resource.path)));
  // Package candidates collapsed behind a rejected project alias, resolved with
  // Pi's own project package filters applied.
  const aliasFreeSkills = rejectedProjectPaths.size === 0 ? [] : await resolveAliasFreePackageSkills(cwd, options);
  const recoveredPackages = aliasFreeSkills.filter(resource => rejectedProjectPaths.has(canonicalPath(resource.path)));

  const disabledNames = new Set([
    ...discoveredSkillNames(primaryResources.skills.filter(resource => !resource.enabled), cwd, options.agentDir),
    ...discoveredSkillNames(fallbackResources.skills.filter(resource => !resource.enabled), cwd, options.agentDir),
    ...discoveredSkillNames(recoveredPackages.filter(resource => !resource.enabled), cwd, options.agentDir),
  ]);
  const project = discoveredSkills(
    primaryResources.skills.filter(resource => resource.enabled && resource.metadata.origin === "top-level" && resource.metadata.scope === "project" && !isSymlinkedProjectSkill(resource, cwd)),
    cwd,
    options.agentDir,
  );
  const user = discoveredSkills(
    [
      ...primaryResources.skills,
      // Only restore a user candidate Pi collapsed behind a rejected project alias.
      // Other fallback user resources could bypass Pi's project filters.
      ...fallbackResources.skills.filter(resource => rejectedProjectPaths.has(canonicalPath(resource.path))),
    ].filter(resource => resource.enabled && resource.metadata.origin === "top-level" && resource.metadata.scope === "user" && !isAmbientUserAgentsSkill(resource, options.homeDir)),
    cwd,
    options.agentDir,
  );
  const packages = discoveredSkills(
    [
      ...primaryResources.skills,
      // Only restore a package candidate Pi collapsed behind a rejected project alias.
      ...recoveredPackages,
    ].filter(resource => resource.enabled && resource.metadata.origin === "package" && !isAmbientUserAgentsSkill(resource, options.homeDir)),
    cwd,
    options.agentDir,
  );

  return skillNames.map(name => {
    const native = project.get(name) ?? user.get(name) ?? packages.get(name);
    const content = native
      ?? (disabledNames.has(name)
        ? undefined
        : (options.settingsManager.isProjectTrusted() ? findInRoots(projectSkillRoots(cwd).map(root => join(root, "skills")), name, false) : undefined)
          ?? findInRoots(userLegacySkillRoots(options.agentDir, options.homeDir), name, true));
    return { name, content: content ?? `(Skill "${name}" not found in Pi's configured skill resources)` };
  });
}

/** Absolutize a project package's relative local source, which Pi resolves against `<cwd>/.pi`. */
function absolutizeProjectSource(source: string, cwd: string): string {
  return /^\.{1,2}($|[\\/])/.test(source) ? resolve(cwd, ".pi", source) : source;
}

/**
 * Resolve package skills as Pi would, minus the project's top-level skill dirs.
 *
 * Pi collapses resources by realpath, so a rejected project symlink can hide a
 * package skill together with the project package filter that applies to it.
 * Resolving from an empty scratch cwd, with the real project settings and
 * npm/git install roots carried over, keeps Pi as the owner of those filters.
 */
async function resolveAliasFreePackageSkills(cwd: string, options: SkillPreloadOptions): Promise<ResolvedResource[]> {
  const scratch = mkdtempSync(join(tmpdir(), "skill-preload-"));
  try {
    for (const dir of ["npm", "git"]) {
      const real = join(cwd, ".pi", dir);
      if (!existsSync(real)) continue;
      mkdirSync(join(scratch, ".pi"), { recursive: true });
      symlinkSync(real, join(scratch, ".pi", dir), "dir");
    }
    const settingsManager = SettingsManager.create(scratch, options.agentDir, { projectTrusted: options.settingsManager.isProjectTrusted() });
    Object.assign(settingsManager, {
      getGlobalSettings: () => options.settingsManager.getGlobalSettings(),
      getProjectSettings: () => {
        const project = options.settingsManager.getProjectSettings();
        return { ...project, packages: project.packages?.map(pkg => typeof pkg === "string"
          ? absolutizeProjectSource(pkg, cwd)
          : { ...pkg, source: absolutizeProjectSource(pkg.source, cwd) }) };
      },
    });
    const manager = createHomePackageManager({ cwd: scratch, agentDir: options.agentDir, settingsManager }, options.homeDir);
    return (await manager.resolve(skipMissingSource)).skills.filter(resource => resource.metadata.origin === "package");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Resolve native disabled paths through Pi's parser, preserving every filter form it supports. */
function discoveredSkillNames(resources: ResolvedResource[], cwd: string, agentDir: string): Set<string> {
  return new Set(loadSkills({ cwd, agentDir, skillPaths: resources.map(resource => resource.path), includeDefaults: false }).skills.map(skill => skill.name));
}

/** Load Pi-valid skills from a precedence tier, retaining the first declared name. */
function discoveredSkills(resources: ResolvedResource[], cwd: string, agentDir: string): Map<string, string> {
  const skills = loadSkills({ cwd, agentDir, skillPaths: resources.map(resource => resource.path), includeDefaults: false }).skills;
  return new Map(skills.map(skill => [skill.name, readFileSync(skill.filePath, "utf-8").trim()]));
}

/** Preserve the historical legacy user roots and raw top-level `<name>.md` lookup. */
function userLegacySkillRoots(agentDir: string, homeDir?: string): string[] {
  const home = resolve(homeDir ?? homedir());
  return [join(agentDir, "skills"), join(home, ".agents", "skills"), join(home, ".pi", "skills")];
}

/** Find a named legacy skill under roots in order without broadening Pi discovery. */
function findInRoots(roots: string[], name: string, trusted: boolean): string | undefined {
  if (isUnsafeName(name)) return undefined;
  for (const root of roots) {
    const content = findInRoot(root, name, trusted);
    if (content !== undefined) return content;
  }
  return undefined;
}

/** Match the former preloader's flat-file and recursive Agent Skills lookup. */
function findInRoot(root: string, name: string, trusted: boolean): string | undefined {
  if (!trusted && isPathThroughSymlink(dirname(root), root)) return undefined;
  const flat = readSkillFile(join(root, `${name}.md`), trusted)?.trim();
  if (flat !== undefined) return flat;
  if (!existsSync(root)) return undefined;

  const queue = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (!trusted && isPathThroughSymlink(dirname(root), current)) continue;
    if (trusted) {
      const canonical = canonicalPath(current);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
    }
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (!trusted && isPathThroughSymlink(dirname(root), path)) continue;
      const isDirectory = entry.isDirectory() || (trusted && entry.isSymbolicLink() && isDirectoryTarget(path));
      if (!isDirectory) continue;
      const skillFile = join(path, "SKILL.md");
      if (existsSync(skillFile)) {
        if (entry.name === name) return readSkillFile(skillFile, trusted)?.trim();
        continue;
      }
      queue.push(path);
    }
  }
  return undefined;
}

function readSkillFile(path: string, trusted: boolean): string | undefined {
  if (!trusted) return safeReadFile(path);
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf-8") : undefined;
  } catch {
    return undefined;
  }
}

function isDirectoryTarget(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Match Pi's realpath identity without importing its private path utility. */
function canonicalPath(path: string): string {
  return realpathSync(path);
}

/** Exclude Pi's ambient user root when a caller supplies a distinct injected home. */
export function isAmbientUserAgentsSkill(resource: ResolvedResource, homeDir?: string, runtimeHome = homedir()): boolean {
  if (homeDir === undefined || resource.metadata.scope !== "user" || resource.metadata.source !== "auto") return false;
  const injectedRoot = join(resolve(homeDir), ".agents", "skills");
  return !isPathWithin(injectedRoot, resource.path) && isPathWithin(join(runtimeHome, ".agents", "skills"), resource.path);
}

/** Reject project symlinks before accepting their resources or resolving collisions. */
function isSymlinkedProjectSkill(resource: ResolvedResource, cwd: string): boolean {
  if (resource.metadata.scope !== "project" || resource.metadata.origin !== "top-level") return false;
  return projectSkillRoots(cwd).some(root => isPathThroughSymlink(root, resource.path));
}

/** Match Pi's project skill roots while checking their parent directories too. */
function projectSkillRoots(cwd: string): string[] {
  const roots = [join(cwd, ".pi")];
  let directory = resolve(cwd);
  while (true) {
    roots.push(join(directory, ".agents"));
    if (existsSync(join(directory, ".git"))) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
}

function isPathWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function isPathThroughSymlink(root: string, path: string): boolean {
  const absoluteRoot = resolve(root);
  if (!isPathWithin(absoluteRoot, path)) return false;
  const relativePath = relative(absoluteRoot, resolve(path));
  let current = absoluteRoot;
  if (isSymlink(current)) return true;
  for (const segment of relativePath === "" ? [] : relativePath.split(sep)) {
    current = join(current, segment);
    if (isSymlink(current)) return true;
  }
  return false;
}
