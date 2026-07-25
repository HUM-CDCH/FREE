import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "./_http.js";
import {
	PROVIDERS,
	appendProviderResource,
	extractionRenderer,
	providerTable,
	resolveModel,
} from "./_provider.js";

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
			"AI_PROVIDER must be 'ollama', 'codex-cli', or 'claude-code'",
		);
	});
});

describe("extractionRenderer", () => {
	it("keeps Ollama on the NuExtract raw renderer", () => {
		vi.stubEnv("AI_PROVIDER", "ollama");

		expect(extractionRenderer()).toBe("nuextract-raw");
	});

	it("uses the generic renderer for Codex CLI", () => {
		vi.stubEnv("AI_PROVIDER", "codex-cli");

		expect(extractionRenderer()).toBe("generic");
	});
});

describe("provider table", () => {
	// Pinned as literals: a wrong default base, credential mode, or raw-NuExtract
	// flag is as damaging as a missing provider and is invisible to a self-comparison.
	it("exposes all seven descriptors verbatim in stable order", () => {
		expect(PROVIDERS).toEqual([
			{
				kind: "ollama",
				label: "Ollama",
				transport: "http",
				defaultBaseUrl: "http://127.0.0.1:11434/api",
				authentication: "optional",
				supportsNuextractRaw: true,
			},
			{
				kind: "openai",
				label: "OpenAI",
				transport: "http",
				defaultBaseUrl: "https://api.openai.com/v1",
				authentication: "managed",
				supportsNuextractRaw: false,
			},
			{
				kind: "anthropic",
				label: "Anthropic",
				transport: "http",
				defaultBaseUrl: "https://api.anthropic.com/v1",
				authentication: "managed",
				supportsNuextractRaw: false,
			},
			{
				kind: "google",
				label: "Google",
				transport: "http",
				defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
				authentication: "managed",
				supportsNuextractRaw: false,
			},
			{
				kind: "codex-cli",
				label: "Codex CLI",
				transport: "cli",
				defaultBaseUrl: null,
				authentication: "external",
				supportsNuextractRaw: false,
			},
			{
				kind: "claude-code",
				label: "Claude Code",
				transport: "cli",
				defaultBaseUrl: null,
				authentication: "external",
				supportsNuextractRaw: false,
			},
			{
				kind: "openai-compatible",
				label: "OpenAI-compatible",
				transport: "http",
				defaultBaseUrl: null,
				authentication: "optional",
				supportsNuextractRaw: false,
			},
		]);
		expect(Object.keys(providerTable)).toEqual(PROVIDERS.map(({ kind }) => kind));
	});

	// Group 5 adds jsonOutput/temperatureSupported to the table; neither may reach the wire.
	it("keeps backend-only capabilities out of the serialisable descriptor", () => {
		for (const descriptor of PROVIDERS) {
			expect(Object.keys(descriptor).sort()).toEqual([
				"authentication",
				"defaultBaseUrl",
				"kind",
				"label",
				"supportsNuextractRaw",
				"transport",
			]);
		}
	});

	it("joins a resource below the stored base without discarding its path prefix", () => {
		expect(appendProviderResource("https://host.example/proxy/openai/v1", "models")).toBe(
			"https://host.example/proxy/openai/v1/models",
		);
		expect(appendProviderResource("https://host.example/v1/", "/models")).toBe(
			"https://host.example/v1/models",
		);
	});
});
