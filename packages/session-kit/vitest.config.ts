import { defineConfig } from "vitest/config";

// forks, not threads: same reason as pi-dev-tools (extension timers stall under the threads pool).
export default defineConfig({ test: { pool: "forks", maxWorkers: 2, testTimeout: 20_000 } });
