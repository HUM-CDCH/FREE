import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "./_http.js";
import {
	GEMMA_SCHEMA_TOOL_MODELS,
	SELECTED_SCHEMA_CHAT_MODEL,
	resolveSchemaChatProbeConfig,
	schemaChatProbeRoute,
} from "./_schema_chat_probe.ts";

afterEach(() => vi.unstubAllEnvs());

describe("resolveSchemaChatProbeConfig", () => {
	it("selects the verified Gemma default and VPN endpoint", () => {
		vi.stubEnv("AI_CHAT_PROVIDER", "");
		vi.stubEnv("AI_CHAT_MODEL", "");
		vi.stubEnv("AI_CHAT_BASE_URL", "");

		expect(resolveSchemaChatProbeConfig()).toEqual({
			provider: "ollama",
			model: SELECTED_SCHEMA_CHAT_MODEL,
			baseURL: "http://spark.cdch-dgxspark.lan.ku.dk:11434",
		});
		expect(GEMMA_SCHEMA_TOOL_MODELS).toContain(SELECTED_SCHEMA_CHAT_MODEL);
	});

	it("allows each verified alternative", () => {
		for (const model of GEMMA_SCHEMA_TOOL_MODELS) {
			vi.stubEnv("AI_CHAT_MODEL", model);
			expect(resolveSchemaChatProbeConfig().model).toBe(model);
		}
	});

	it("maps an unsupported provider to a clear route error", async () => {
		vi.stubEnv("AI_CHAT_PROVIDER", "codex-cli");

		expect(() => resolveSchemaChatProbeConfig()).toThrow(RequestError);
		const response = await schemaChatProbeRoute([]);
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			detail: "AI_CHAT_PROVIDER must be 'ollama' for schema chat",
		});
	});

	it("maps an unverified model to a clear route error", () => {
		vi.stubEnv("AI_CHAT_MODEL", "gemma3:4b");

		expect(() => resolveSchemaChatProbeConfig()).toThrow(
			"AI_CHAT_MODEL gemma3:4b has not been verified for schema tools",
		);
	});
});
