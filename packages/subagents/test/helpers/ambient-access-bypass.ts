/** Deliberately exercise ambient-home APIs that ordinary fs proxies can miss. */
import fs from "node:fs";
import { join } from "node:path";

export type AmbientAccessBypass = "bun-file" | "glob-cwd" | "realpath-native" | "streams";

/** Invoke one path-bearing runtime API against a unique decoy ambient path. */
export async function exerciseAmbientAccessBypass(ambient: string, bypass: AmbientAccessBypass): Promise<void> {
  switch (bypass) {
    case "bun-file": {
      const runtime = globalThis as typeof globalThis & { Bun?: { file(path: string): { exists(): Promise<boolean> } } };
      if (!runtime.Bun) throw new Error("Bun.file bypass requires Bun");
      await runtime.Bun.file(join(ambient, ".agents", "bun-file")).exists();
      return;
    }
    case "glob-cwd":
      fs.globSync([join(ambient, ".agents", "glob-pattern", "*.missing"), "*.missing"], { cwd: join(ambient, ".agents", "glob-cwd") });
      return;
    case "realpath-native": {
      (fs.realpathSync.native ?? fs.realpathSync)(join(ambient, ".agents", "native-realpath-sync"));
      await new Promise<void>((resolve, reject) => fs.realpath.native(join(ambient, ".agents", "native-realpath-callback"), error => error ? reject(error) : resolve()));
      return;
    }
    case "streams": {
      const reader = new fs.ReadStream(join(ambient, ".agents", "read-stream"));
      const writer = new fs.WriteStream(join(ambient, ".agents", "write-stream"));
      reader.destroy();
      writer.destroy();
      return;
    }
  }
}
