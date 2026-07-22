import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOllama, ollama } from "ai-sdk-ollama";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { claudeCode } from 'ai-sdk-provider-claude-code';
import { RequestError } from "./_http.js";

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
