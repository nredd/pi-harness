// Faults the real host never produces on a developer machine: a Pi that lacks the package-manager
// API the peer range `>=1.1.0` allows, and a filesystem whose root cannot be canonicalized (e.g. a
// missing drive on Windows).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ manager: "real" as "real" | "missing" | "no-listing", failRealpath: false }));

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    get DefaultPackageManager() {
      if (host.manager === "missing") return undefined;
      if (host.manager === "no-listing") return class {};
      return actual.DefaultPackageManager;
    },
  };
});

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => {
      if (host.failRealpath) throw new Error("ENOENT: realpath");
      return actual.realpathSync(...args);
    },
    actual.realpathSync,
  );
  return { ...actual, realpathSync };
});

import { listPiPackages, resolveDeclaredPaths } from "../src/package-resources.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-pkghost-"));
});

afterEach(() => {
  host.manager = "real";
  host.failRealpath = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("listPiPackages against a host without the package manager API", () => {
  it("contributes no packages when DefaultPackageManager is not a constructor", () => {
    host.manager = "missing";
    expect(listPiPackages(dir)).toEqual([]);
  });

  it("contributes no packages when the manager cannot list configured packages", () => {
    host.manager = "no-listing";
    expect(listPiPackages(dir)).toEqual([]);
  });
});

describe("resolveDeclaredPaths when no ancestor can be canonicalized", () => {
  it("records an exclusion under the unresolved path instead of recursing past the root", () => {
    mkdirSync(join(dir, "agents"), { recursive: true });
    host.failRealpath = true;

    const { excluded } = resolveDeclaredPaths(dir, ["!./agents/wip.md"], "agents");

    // Every ancestor fails, so the walk bottoms out at the filesystem root and re-joins the
    // remaining segments verbatim: the path comes back as written.
    expect([...excluded]).toEqual([join(dir, "agents", "wip.md")]);
  });
});
