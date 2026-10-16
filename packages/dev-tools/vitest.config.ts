import { defineConfig } from "vitest/config";

// Child processes, not worker threads: pi loads extensions on the main thread, and the process
// runner's signal handling showed stalls under the threads pool that never reproduce in forks.
// Two workers at most: the cargo and uv suites compile real projects, and a cold build running
// next to the timing-sensitive core tests made them flaky.
export default defineConfig({ test: { pool: "forks", maxWorkers: 2, testTimeout: 20_000 } });
