import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["evaluation/**/*.evaluation.ts"],
		testTimeout: 20 * 60 * 1000,
		hookTimeout: 20 * 60 * 1000,
		maxWorkers: 1,
	},
});
