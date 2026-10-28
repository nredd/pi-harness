import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { setupFiles: ["../../integration/inprocess/verification/home-setup.ts"] },
});
