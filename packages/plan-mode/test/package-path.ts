import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve package fixtures independently of the standalone or monorepo runner's cwd. */
export function packagePath(...parts: string[]): string {
  return resolve(fileURLToPath(new URL("../", import.meta.url)), ...parts);
}
