/** Bind real extension activation to a disposable home, never a runtime HOME mutation. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createSubagentsExtension as createAtHome, type SubagentsExtensionOptions } from "../../src/index.js";

export * from "../../src/index.js";

const fallbackHome = mkdtempSync(join(tmpdir(), "subagents-extension-home-"));
afterAll(() => rmSync(fallbackHome, { recursive: true, force: true }));

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}) {
  return createAtHome({ homeDir: process.env.PI_CODING_AGENT_DIR || fallbackHome, ...options });
}

export default (pi: Parameters<ReturnType<typeof createAtHome>>[0]) => createSubagentsExtension()(pi);
