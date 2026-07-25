import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOllama, ollama } from "ai-sdk-ollama";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { claudeCode } from 'ai-sdk-provider-claude-code';
import { RequestError } from "./_http.js";

export type ProviderKind =
	| "ollama"
	| "openai"
	| "anthropic"
	| "google"
	| "codex-cli"
	| "claude-code"
	| "openai-compatible";

export type ProviderDescriptor = {
	kind: ProviderKind;
	label: string;
	transport: "http" | "cli";
	defaultBaseUrl: string | null;
	authentication: "managed" | "optional" | "external";
	supportsNuextractRaw: boolean;
};

// The one table every layer asks about a provider. Discovery adapters, model
// factories, and execution capabilities join these rows in later task groups.
export const providerTable = {
	ollama: {
		kind: "ollama",
		label: "Ollama",
		transport: "http",
		defaultBaseUrl: "http://127.0.0.1:11434/api",
		authentication: "optional",
		supportsNuextractRaw: true,
	},
	openai: {
		kind: "openai",
		label: "OpenAI",
		transport: "http",
		defaultBaseUrl: "https://api.openai.com/v1",
		authentication: "managed",
		supportsNuextractRaw: false,
	},
	anthropic: {
		kind: "anthropic",
		label: "Anthropic",
		transport: "http",
		defaultBaseUrl: "https://api.anthropic.com/v1",
		authentication: "managed",
		supportsNuextractRaw: false,
	},
	google: {
		kind: "google",
		label: "Google",
		transport: "http",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		authentication: "managed",
		supportsNuextractRaw: false,
	},
	"codex-cli": {
		kind: "codex-cli",
		label: "Codex CLI",
		transport: "cli",
		defaultBaseUrl: null,
		authentication: "external",
		supportsNuextractRaw: false,
	},
	"claude-code": {
		kind: "claude-code",
		label: "Claude Code",
		transport: "cli",
		defaultBaseUrl: null,
		authentication: "external",
		supportsNuextractRaw: false,
	},
	"openai-compatible": {
		kind: "openai-compatible",
		label: "OpenAI-compatible",
		transport: "http",
		defaultBaseUrl: null,
		authentication: "optional",
		supportsNuextractRaw: false,
	},
} as const satisfies Record<ProviderKind, ProviderDescriptor>;

/** Stable provider order for the Model Connection page. */
export const PROVIDERS: readonly ProviderDescriptor[] = Object.values(providerTable);

/**
 * A stored API base is the exact provider root, version prefix included, so a
 * resource joins below it. Trailing slashes are insignificant and stripped here
 * rather than when the researcher's value is read back.
 */
export function appendProviderResource(baseUrl: string, resource: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${resource.replace(/^\/+/, "")}`;
}

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5-20250514"
const PROVIDER_MESSAGE = "AI_PROVIDER must be 'ollama', 'codex-cli', or 'claude-code'";

declare const process: {
	env: Record<string, string | undefined>;
};

type Provider = "ollama" | "codex-cli" | "claude-code";

// Reuse one app-server process across requests; the provider reaps it after the idle timeout.
let codexAppServer: ReturnType<typeof createCodexAppServer> | null = null;

function isolatedCodexWorkingDirectory(): string {
	try {
		// mkdtemp is atomic, unpredictable, and 0o700 by default — called once
		// per process because codexProvider() caches the app server.
		return mkdtempSync(join(tmpdir(), "free-codex-sandbox-"));
	} catch {
		throw new RequestError(
			500,
			"Could not create the isolated Codex working directory",
		);
	}
}

function codexProvider(): ReturnType<typeof createCodexAppServer> {
	codexAppServer ??= createCodexAppServer({
		defaultSettings: {
			approvalPolicy: "never",
			codexPath: "codex",
			cwd: isolatedCodexWorkingDirectory(),
			effort: "none",
			sandboxPolicy: "read-only",
			idleTimeoutMs: 60_000,
			minCodexVersion: "0.144.0",
			logger: false,
			// Source Documents and extraction instructions are untrusted. Codex is
			// used only as a model boundary here, never as a coding/tool agent.
			configOverrides: {
				mcp_servers: {},
				"tools.web_search": false,
				"features.apps": false,
				"features.browser_use": false,
				"features.code_mode_host": false,
				"features.computer_use": false,
				"features.image_generation": false,
				"features.multi_agent": false,
				"features.shell_snapshot": false,
				"features.shell_tool": false,
				"features.tool_suggest": false,
				"features.unified_exec": false,
			},
		},
	});
	return codexAppServer;
}

function provider(): Provider {
	const value = process.env.AI_PROVIDER;
	if (!value || value === "ollama") {
		return "ollama";
	}
	if (value === "codex-cli" || value === "claude-code") {
		return value;
	}
	throw new RequestError(500, PROVIDER_MESSAGE);
}

export function resolveModel(): ReturnType<typeof ollama> {
	const selectedProvider = provider();
	const modelId =
		process.env.AI_MODEL ||
		(selectedProvider === "codex-cli"
			? DEFAULT_CODEX_MODEL
			: selectedProvider === "claude-code"
				? DEFAULT_CLAUDE_MODEL
				: DEFAULT_MODEL);

	if (selectedProvider === "codex-cli") {
		return codexProvider()(modelId);
	}

	if (selectedProvider === "claude-code") {
		// Source Documents and extraction instructions are untrusted. Claude Code
		// is used only as a model boundary here, never as a coding/tool agent.
		return claudeCode(modelId, { tools: [], settingSources: [] });
	}

	const baseURL = process.env.AI_BASE_URL;
	const apiKey = process.env.AI_API_KEY;
	if (baseURL) {
		return createOllama({ baseURL, apiKey })(modelId);
	}
	if (apiKey) {
		return createOllama({ apiKey })(modelId);
	}
	return ollama(modelId);
}

export function extractionRenderer(): "nuextract-raw" | "generic" {
	return provider() === "ollama" ? "nuextract-raw" : "generic";
}
