import { z } from "zod";
import {
	validateExtractionSchema,
	type ExtractionSchemaEnvelope,
} from "../shared/schema.js";
import { createSchemaAgentUIResponse } from "./_chat_agent.js";
import { modelError } from "./_model.js";

const messagePartSchema = z
	.record(z.string(), z.unknown())
	.refine(
		(part) => typeof part.type === "string",
		"Message part type required",
	);

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
