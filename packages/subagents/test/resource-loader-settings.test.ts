import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHomeResourceLoader, normalizeResourceSettings } from "../src/resource-loader.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-resource-loader-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("normalizeResourceSettings", () => {
  it("expands a bare `~` entry to the injected home and keeps its filter modifier", () => {
    const out = normalizeResourceSettings({ extensions: ["~", "-~", "+~/ext", "./local"] }, "/injected/home");
    expect(out.extensions).toEqual(["/injected/home", "-/injected/home", "+" + join("/injected/home", "ext"), "./local"]);
  });
});

describe("normalizeResourceSettings on Windows", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", realPlatform));

  it("expands a backslash tilde entry only there", () => {
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    expect(normalizeResourceSettings({ skills: ["~\\skills"] }, "C:\\home").skills).toEqual([join("C:\\home", "skills")]);
    Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
    expect(normalizeResourceSettings({ skills: ["~\\skills"] }, "/home").skills).toEqual(["~\\skills"]);
  });
});

describe("createHomeResourceLoader", () => {
  it("builds its own settings manager from cwd and agentDir when none is given", () => {
    const agentDir = join(root, "agent");
    const loader = createHomeResourceLoader({ cwd: root, agentDir }, join(root, "home"));
    expect(loader).toBeDefined();
    expect(loader.getExtensions()).toBeDefined();
  });

  it("wraps a supplied settings manager so its readers see the injected home", () => {
    const settingsManager = SettingsManager.inMemory({ extensions: ["~/ext"] });
    createHomeResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager }, "/injected/home");
    expect(settingsManager.getGlobalSettings().extensions).toEqual([join("/injected/home", "ext")]);
  });
});
