/**
 * skill-loader.ts — Preload named skills.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself contains
 * SKILL.md is a skill — we don't descend into it (Pi: skills don't nest).
 *
 * Project roots reject symlinks at every layer: a cloned repository must not be able to
 * point a skill at files outside it (deviation from Pi). User roots belong to the user and
 * follow symlinks like Pi does — that is how skill installers and dotfile managers link
 * skills in — skipping broken links and directory cycles.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSymlink, isUnsafeName, resolveAgentDir, safeReadFile } from "./memory.js";

export interface PreloadedSkill {
  name: string;
  content: string;
}

export function preloadSkills(skillNames: string[], cwd: string, homeDir = homedir()): PreloadedSkill[] {
  return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd, homeDir) }));
}

function loadSkillContent(name: string, cwd: string, homeDir: string): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  // `trusted`: user-owned root, symlinks followed. Project roots stay strict.
  const agentDir = resolveAgentDir(homeDir);
  const roots = [
    { path: join(cwd, ".pi", "skills"), trusted: false }, // project — Pi standard
    { path: join(cwd, ".agents", "skills"), trusted: false }, // project — Agent Skills spec
    { path: join(agentDir, "skills"), trusted: true }, // user — Pi standard
    { path: join(homeDir, ".agents", "skills"), trusted: true }, // user — Agent Skills spec
    { path: join(homeDir, ".pi", "skills"), trusted: true }, // legacy global, pre-Pi
  ];
  for (const root of roots) {
    const content = findInRoot(root.path, name, root.trusted);
    if (content !== undefined) return content;
  }
  return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

function findInRoot(root: string, name: string, trusted: boolean): string | undefined {
  // Reject a project root that is, or sits in, a link: `<cwd>/.pi -> /elsewhere` counts too.
  if (!trusted && (isSymlink(root) || isSymlink(dirname(root)))) return undefined;
  const flat = readSkillFile(join(root, `${name}.md`), trusted)?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name, trusted);
}

/** A regular file's text; `trusted` also follows a symlink to one, else symlinks are refused. */
function readSkillFile(path: string, trusted: boolean): string | undefined {
  if (!trusted) return safeReadFile(path);
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf-8") : undefined;
  } catch {
    return undefined; // missing or broken link
  }
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
function findSkillDirectory(root: string, name: string, trusted: boolean): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];
  // Canonical paths already queued: a followed link back to an ancestor cannot loop.
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (trusted) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
    }

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      // Dirent uses lstat semantics, so a symlinked dir is not `isDirectory()`: refused unless trusted.
      if (!entry.isDirectory() && !(trusted && entry.isSymbolicLink() && isDirectoryTarget(path))) continue;

      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const content = readSkillFile(skillMd, trusted)?.trim();
          if (content !== undefined) return content;
        }
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}

function isDirectoryTarget(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // broken link
  }
}
