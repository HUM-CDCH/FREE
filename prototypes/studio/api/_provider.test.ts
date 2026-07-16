import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "./_http.js";
import { resolveModel } from "./_provider.js";

afterEach(() => vi.unstubAllEnvs());

describe("resolveModel", () => {
	it("defaults to Ollama when AI_PROVIDER is unset", () => {
		vi.stubEnv("AI_PROVIDER", "");
		vi.stubEnv("AI_MODEL", "");
		vi.stubEnv("AI_BASE_URL", "");
		vi.stubEnv("AI_API_KEY", "");

		const model = resolveModel();

		expect(model.modelId).toBe("llama3.2");
		expect(model.provider).toContain("ollama");
	});

	it("uses the configured Codex CLI model", () => {
		vi.stubEnv("AI_PROVIDER", "codex-cli");
		vi.stubEnv("AI_MODEL", "gpt-5.6-terra");

		const model = resolveModel();

		expect(model.modelId).toBe("gpt-5.6-terra");
		expect(model.provider).toBe("codex-app-server");
		expect(model).toMatchObject({
			settings: {
				approvalPolicy: "never",
				cwd: expect.stringContaining("free-codex-sandbox-"),
				sandboxPolicy: "read-only",
				requestTimeoutMs: 120_000,
				configOverrides: {
					mcp_servers: {},
					"tools.web_search": false,
					"features.shell_tool": false,
					"features.unified_exec": false,
				},
			},
		});
	});

	it("rejects unknown providers", () => {
		vi.stubEnv("AI_PROVIDER", "unknown");

		expect(() => resolveModel()).toThrow(RequestError);
		expect(() => resolveModel()).toThrow(
			"AI_PROVIDER must be 'ollama' or 'codex-cli'",
		);
	});
});
