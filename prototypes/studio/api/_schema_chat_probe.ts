import {
	ToolLoopAgent,
	createAgentUIStreamResponse,
	hasToolCall,
	isStepCount,
	tool,
	type UIMessage,
} from "ai";
import { createOllama } from "ai-sdk-ollama";
import { z } from "zod";
import { RequestError, modelError } from "./_http.js";

export const GEMMA_SCHEMA_TOOL_MODELS = [
	"gemma4:12b-it-qat",
	"gemma4:e4b-it-qat",
	"gemma4:26b-a4b-it-qat",
] as const;

export const SELECTED_SCHEMA_CHAT_MODEL = "gemma4:26b-a4b-it-qat";
const DEFAULT_BASE_URL = "http://spark.cdch-dgxspark.lan.ku.dk:11434";
const MAX_PROBE_STEPS = 3;

type SchemaChatProbeModel = (typeof GEMMA_SCHEMA_TOOL_MODELS)[number];

declare const process: { env: Record<string, string | undefined> };

export function resolveSchemaChatProbeConfig(): {
	provider: "ollama";
	model: SchemaChatProbeModel;
	baseURL: string;
} {
	const provider = process.env.AI_CHAT_PROVIDER || "ollama";
	if (provider !== "ollama") {
		throw new RequestError(
			500,
			"AI_CHAT_PROVIDER must be 'ollama' for schema chat",
		);
	}

	const model = process.env.AI_CHAT_MODEL || SELECTED_SCHEMA_CHAT_MODEL;
	if (!GEMMA_SCHEMA_TOOL_MODELS.includes(model as SchemaChatProbeModel)) {
		throw new RequestError(
			500,
			`AI_CHAT_MODEL ${model} has not been verified for schema tools`,
		);
	}

	const configuredBaseURL = process.env.AI_CHAT_BASE_URL || DEFAULT_BASE_URL;
	return {
		provider,
		model: model as SchemaChatProbeModel,
		baseURL: `${configuredBaseURL.replace(/\/$/, "")}/api`,
	};
}

const schemaChangeSchema = z.discriminatedUnion("operation", [
	z.object({
		operation: z.literal("set"),
		path: z.array(z.string()),
		value: z.string(),
	}),
	z.object({ operation: z.literal("remove"), path: z.array(z.string()) }),
	z.object({
		operation: z.literal("rename"),
		path: z.array(z.string()),
		name: z.string(),
	}),
]);

export function createSchemaChatProbeAgent() {
	const config = resolveSchemaChatProbeConfig();
	return new ToolLoopAgent({
		model: createOllama({ baseURL: config.baseURL })(config.model),
		instructions:
			"You verify Extraction Schema changes. When asked to change a field, call proposeSchemaChange with the explicit operation requested.",
		tools: {
			proposeSchemaChange: tool({
				description:
					"Propose exactly one explicit set, remove, or rename Extraction Schema operation.",
				inputSchema: schemaChangeSchema,
				outputSchema: z.object({
					validated: z.literal(true),
					change: schemaChangeSchema,
				}),
				execute: async (change) => ({ validated: true as const, change }),
			}),
		},
		stopWhen: [
			hasToolCall("proposeSchemaChange"),
			isStepCount(MAX_PROBE_STEPS),
		],
	});
}

export async function createSchemaChatProbeResponse(
	uiMessages: UIMessage[],
	abortSignal?: AbortSignal,
): Promise<Response> {
	return createAgentUIStreamResponse({
		agent: createSchemaChatProbeAgent(),
		uiMessages,
		abortSignal,
	});
}

export async function schemaChatProbeRoute(
	uiMessages: UIMessage[],
	abortSignal?: AbortSignal,
): Promise<Response> {
	try {
		return await createSchemaChatProbeResponse(uiMessages, abortSignal);
	} catch (error) {
		return modelError(error);
	}
}
