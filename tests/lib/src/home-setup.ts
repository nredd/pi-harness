import { afterEach, beforeEach, expect } from "vitest";
import { installHomeGuard } from "./home-guard.ts";

// Setup runs inside each engine's worker, not in the Node launcher.
installHomeGuard(expect.getState().testPath, { beforeEach, afterEach });
