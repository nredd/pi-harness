import { afterEach, beforeEach, expect } from "vitest";
import { assertHomeDirectory } from "./home-guard.ts";

// Setup runs inside each engine's worker, not in the Node launcher.
assertHomeDirectory(expect.getState().testPath ?? "<unknown test file>");
beforeEach(({ task }) => assertHomeDirectory(task.file.filepath));
afterEach(({ task }) => assertHomeDirectory(task.file.filepath));
