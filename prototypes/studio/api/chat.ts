import { z } from "zod";
import {
	validateExtractionSchema,
	type ExtractionSchemaEnvelope,
} from "../shared/schema.js";
import {
	createSchemaAgentUIResponse,
	schemaProposalInputSchema,
	schemaSuggestionSchema,
} from "./_chat_agent.js";
import { modelError } from "./_model.js";

const textPartSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.strict();

const proposalPartBase = {
	type: z.literal("tool-proposeSchemaChanges"),
	toolCallId: z.string().min(1),
};
const proposalPartSchema = z.discriminatedUnion("state", [
	z
		.object({ ...proposalPartBase, state: z.literal("input-streaming") })
		.strict(),
	z
		.object({
			...proposalPartBase,
			state: z.literal("input-available"),
			input: schemaProposalInputSchema,
		})
		.strict(),
	z
		.object({
			...proposalPartBase,
			state: z.literal("output-available"),
			input: schemaProposalInputSchema,
			output: schemaSuggestionSchema,
		})
		.strict(),
	z
		.object({
			...proposalPartBase,
			state: z.literal("output-error"),
			input: schemaProposalInputSchema,
			errorText: z.string().min(1),
		})
		.strict(),
]);

const messagePartSchema = z.union([textPartSchema, proposalPartSchema]);

const messageSchema = z
	.object({
		id: z.string().min(1),
		role: z.enum(["system", "user", "assistant"]),
		parts: z.array(messagePartSchema),
	})
	.strict();

const annotationSchema = z
	.object({
		id: z.string(),
		text: z.string().min(1),
		pageNumber: z.number().int().positive(),
	})
	.strict();

const requestSchema = z
	.object({
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
	})
	.strict();

export async function POST(request: Request): Promise<Response> {
	try {
		const { messages, ...options } = requestSchema.parse(await request.json());
		return await createSchemaAgentUIResponse({
			uiMessages: messages,
			options,
			abortSignal: request.signal,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return Response.json(
				{ detail: "Invalid chat request." },
				{ status: 400 },
			);
		}
		return modelError(error);
	}
}
