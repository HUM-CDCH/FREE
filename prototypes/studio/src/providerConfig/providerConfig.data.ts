// All mock data for the Model Provider Config page in one place. Adding a
// new connection type or a new routable task means adding one entry below —
// ProviderConfigPage.tsx never branches on a specific kind/task by name.

export type ModelOption = { id: string; label: string };

export type ApiProviderKey = "openai" | "anthropic" | "google";

export type ApiProviderConfig = {
	name: string;
	defaultUrl: string;
	models: ModelOption[];
};

export type ConnectionKind = "ollama" | "api" | "codex" | "claudecode";

export type ConnectionKindConfig = {
	name: string;
	tagline: string;
	/** 'server' takes a URL, 'apikey' nests an API provider choice, 'cli' needs neither. */
	shape: "server" | "apikey" | "cli";
	endpointLabel?: string;
	defaultUrl?: string;
	/** Server connections may accept an optional key (e.g. a gated proxy). */
	keyOptional?: boolean;
	/** Omitted for 'apikey' kinds, whose models come from the chosen ApiProviderConfig instead. */
	models?: ModelOption[];
};

export type Connection = {
	id: string;
	kind: ConnectionKind;
	apiProvider?: ApiProviderKey;
	name: string;
	baseUrl: string;
	apiKey: string;
	reachable: boolean;
};

export type TaskId = "ext" | "chat";

export type TaskConfig = {
	id: TaskId;
	label: string;
	sub: string;
};

export type RouteState = {
	connectionId: string | null;
	model: string | null;
};

export type Draft = {
	kind: ConnectionKind;
	apiProvider?: ApiProviderKey;
	name: string;
	baseUrl: string;
	apiKey: string;
};

export const API_PROVIDERS: Record<ApiProviderKey, ApiProviderConfig> = {
	openai: {
		name: "OpenAI",
		defaultUrl: "https://api.openai.com/v1",
		models: [
			{ id: "gpt-4o", label: "GPT-4o" },
			{ id: "gpt-4o-mini", label: "GPT-4o mini" },
			{ id: "o3", label: "o3" },
		],
	},
	anthropic: {
		name: "Anthropic",
		defaultUrl: "https://api.anthropic.com",
		models: [
			{ id: "claude-sonnet-4", label: "Claude Sonnet 4" },
			{ id: "claude-opus-4", label: "Claude Opus 4" },
			{ id: "claude-haiku-3-5", label: "Claude Haiku 3.5" },
		],
	},
	google: {
		name: "Google",
		defaultUrl: "https://generativelanguage.googleapis.com",
		models: [
			{ id: "gemini-2-5-pro", label: "Gemini 2.5 Pro" },
			{ id: "gemini-2-5-flash", label: "Gemini 2.5 Flash" },
			{ id: "gemma-2", label: "Gemma 2" },
		],
	},
};

export const CONNECTION_KINDS: Record<ConnectionKind, ConnectionKindConfig> = {
	ollama: {
		name: "Ollama server",
		tagline: "Local or self-hosted",
		shape: "server",
		endpointLabel: "Server URL",
		defaultUrl: "http://localhost:11434",
		keyOptional: true,
		models: [
			{ id: "nuextract", label: "NuExtract 2.0" },
			{ id: "gemma-2-9b", label: "Gemma 2 · 9B" },
			{ id: "llama-3.1-8b", label: "Llama 3.1 · 8B" },
			{ id: "qwen-2.5-7b", label: "Qwen 2.5 · 7B" },
		],
	},
	api: {
		name: "API provider",
		tagline: "OpenAI · Anthropic · Google",
		shape: "apikey",
		endpointLabel: "API base URL",
	},
	codex: {
		name: "codex-cli",
		tagline: "Local agent harness",
		shape: "cli",
		models: [{ id: "gpt-5-codex", label: "gpt-5-codex" }],
	},
	claudecode: {
		name: "Claude Code",
		tagline: "Local agent harness",
		shape: "cli",
		models: [{ id: "claude-code-sonnet", label: "Sonnet (via CLI)" }],
	},
};

export const ROUTABLE_TASKS: TaskConfig[] = [
	{
		id: "ext",
		label: "Extraction & Schema Suggestion",
		sub: "Runs over every Source Document",
	},
	{
		id: "chat",
		label: "Chat & Extraction Schema editing",
		sub: "Interactive, conversational",
	},
];

export const INITIAL_CONNECTIONS: Connection[] = [
	{
		id: "c1",
		kind: "ollama",
		name: "Local Ollama",
		baseUrl: "http://localhost:11434",
		apiKey: "",
		reachable: true,
	},
	{
		id: "c2",
		kind: "api",
		apiProvider: "openai",
		name: "OpenAI (lab key)",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "sk-live-…",
		reachable: true,
	},
];

export const INITIAL_ROUTES: Record<TaskId, RouteState> = {
	ext: { connectionId: "c1", model: "nuextract" },
	chat: { connectionId: "c2", model: "gpt-4o" },
};
