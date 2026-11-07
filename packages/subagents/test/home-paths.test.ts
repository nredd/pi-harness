import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHomePath } from "../src/home-paths.js";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...realPlatform, value });
}

afterEach(() => Object.defineProperty(process, "platform", realPlatform));

describe("normalizeHomePath", () => {
  it("expands a bare tilde against the native home when none is injected", () => {
    expect(normalizeHomePath("~")).toBe(homedir());
  });

  describe("on Windows", () => {
    it("maps Git Bash, WSL and Cygwin drive paths to drive letters", () => {
      setPlatform("win32");
      expect(normalizeHomePath("/c/Users/dev")).toBe("C:\\Users\\dev");
      expect(normalizeHomePath("/mnt/d/work/repo")).toBe("D:\\work\\repo");
      expect(normalizeHomePath("/cygdrive/e/x")).toBe("E:\\x");
    });

    it("maps a bare drive root to its drive letter with a trailing backslash", () => {
      setPlatform("win32");
      expect(normalizeHomePath("/c")).toBe("C:\\");
    });

    it("leaves a POSIX-looking path that is not a drive path alone", () => {
      setPlatform("win32");
      expect(normalizeHomePath("/usr/local/bin")).toBe("/usr/local/bin");
    });
  });
});
