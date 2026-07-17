import { z } from "zod";
import {
	validateExtractionSchema,
	type ExtractionSchemaEnvelope,
} from "../shared/schema.js";
import { createSchemaAgentUIResponse } from "./_chat_agent.js";
import { modelError } from "./_model.js";

const textPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const proposalInputSchema = z.object({
	summary: z.string().trim().min(1),
	schema: z.unknown(),
});

const rootSchemaChangeSchema = z
	.object({
		operation: z.literal("set"),
		path: z.tuple([]),
		value: z.unknown(),
	})
	.strict()
	.refine((change) => validateExtractionSchema(change.value).valid, {
		message: "Invalid proposed Extraction Schema",
		path: ["value"],
	});

const proposalOutputSchema = z
	.object({
		id: z.uuid(),
		documentEpoch: z.number().int().nonnegative(),
		baseRevision: z.number().int().nonnegative(),
		summary: z.string().min(1),
		changes: z.tuple([rootSchemaChangeSchema]),
	})
	.strict();

const proposalPartBase = {
	type: z.literal("tool-proposeSchemaChanges"),
	toolCallId: z.string().min(1),
};
const proposalPartSchema = z.discriminatedUnion("state", [
	z.object({ ...proposalPartBase, state: z.literal("input-streaming") }),
	z.object({
		...proposalPartBase,
		state: z.literal("input-available"),
		input: proposalInputSchema,
	}),
	z.object({
		...proposalPartBase,
		state: z.literal("output-available"),
		input: proposalInputSchema,
		output: proposalOutputSchema,
	}),
	z.object({
		...proposalPartBase,
		state: z.literal("output-error"),
		input: proposalInputSchema,
		errorText: z.string().min(1),
	}),
]);

const messagePartSchema = z.union([textPartSchema, proposalPartSchema]);

const messageSchema = z.object({
	id: z.string().min(1),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(messagePartSchema),
});

const annotationSchema = z.object({
	id: z.string(),
	text: z.string().min(1),
	pageNumber: z.number().int().positive(),
});

const requestSchema = z.object({
	messages: z.array(messageSchema),
	markdown: z.string().min(1).nullable(),
	annotations: z.array(annotationSchema),
	schema: z
		.custom<ExtractionSchemaEnvelope>()
		.nullable()
		.refine(
			(value) => value === null || validateExtractionSchema(value).valid,
			"Invalid Extraction Schema",
		),
	revision: z.number().int().nonnegative(),
	documentEpoch: z.number().int().nonnegative(),
});

export async function POST(request: Request): Promise<Response> {
	try {
		const { messages, ...options } = requestSchema.parse(await request.json());
		return await createSchemaAgentUIResponse({
			uiMessages: messages,
			options,
			abortSignal: request.signal,
		});
	} catch (error) {
		return modelError(error);
	}
}
