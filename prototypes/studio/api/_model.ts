import {
	NoObjectGeneratedError,
	Output,
	convertToModelMessages,
	createUIMessageStreamResponse,
	generateText,
	streamText,
	toUIMessageStream,
} from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import type { Annotation, AnnotationMode, DocumentInput } from "./_document.js";
import { documentFileParts, type DocumentFilePart } from "./_pdf.js";
import { schemaPrompt } from "./_schema.js";
import { RequestError } from "./_http.js";
import {
	parseExtractionResult,
	parseTemplate,
	parseUnknownJson,
} from "./_model_output.js";
import { extractionRenderer, resolveModel } from "./_provider.js";
import { parseSchemaOps, SCHEMA_FIELD_TYPES, type SchemaOp } from "../src/schemaOps.js";

export {
	parseAnnotationMode,
	parseAnnotations,
	parseDocument,
} from "./_document.js";
export { json, modelError, parseTemperature } from "./_http.js";

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const IMAGE_PLACEHOLDER = "<|vision_start|><|image_pad|><|vision_end|>";
// NuExtract's recommended non-thinking setting for fast, deterministic
// extraction / schema / markdown. We always render the non-thinking prompt
// (an empty <think></think>), so this is the right default; without it Ollama
// applies ~0.8, which produced noisy, instance-leaking templates.
// ponytail: thinking mode (temp 0.6, <think> left open) isn't wired up — add an
// enable_thinking path in renderNuExtractPrompt if difficult layouts need it.
const NON_THINKING_TEMPERATURE = 0.2;

declare const process: {
	env: Record<string, string | undefined>;
};

export type SchemaModelInput = {
	readonly document: DocumentInput;
	readonly annotations: readonly Annotation[];
	readonly annotationsMode: AnnotationMode;
	readonly temperature?: number;
};

export type StructuredModelInput = {
	readonly document: string;
	readonly schema: Record<string, unknown>;
	readonly instructions: string;
	readonly temperature?: number;
	readonly abortSignal?: AbortSignal;
};

type DocumentContentPart =
	| DocumentFilePart
	| { readonly type: "text"; readonly text: string };
type NuExtractMode = "structured" | "template-generation" | "content";

async function documentContentParts(document: DocumentInput): Promise<{
	readonly parts: readonly DocumentContentPart[];
	readonly pages: number | null;
}> {
	if (document.markdown) {
		return {
			parts: [{ type: "text", text: document.markdown }],
			pages: document.pages,
		};
	}
	if (!document.file) {
		throw new RequestError(
			400,
			"No document content: provide a 'file' or 'document_markdown'",
		);
	}
	const fileParts = await documentFileParts(document.file);
	return { parts: fileParts.parts, pages: fileParts.pages };
}

export async function streamChatWithModel(
	messages: readonly UIMessage[],
): Promise<Response> {
	const result = streamText({
		model: resolveModel(),
		instructions:
			"You help humanities researchers inspect source documents in FREE. If no source document content is attached, say that no document context is available before answering normally.",
		messages: await convertToModelMessages([...messages]),
	});

	return createUIMessageStreamResponse({
		stream: toUIMessageStream({
			stream: result.stream,
			onError: () => "Chat failed.",
		}),
	});
}

export async function generateStructuredWithModel({
	document,
	schema,
	instructions,
	temperature,
	abortSignal,
}: StructuredModelInput): Promise<Record<string, unknown>> {
	const documentParts: readonly DocumentContentPart[] = [
		{ type: "text", text: document },
	];
	const generated =
		extractionRenderer() === "generic"
			? await generateWithGenericJsonPrompt({
					instructions: [
						"Produce a source-grounded FREE Extraction Result matching the supplied JSON shape exactly. Return only one JSON object with no Markdown or commentary.",
						instructions,
						`Extraction Schema:\n${JSON.stringify(schema, null, 2)}`,
					].join("\n\n"),
					request: null,
					documentParts,
					temperature,
					abortSignal,
				})
			: await generateWithNuExtractRawPrompt({
					mode: "structured",
					template: JSON.stringify(schema, null, 2),
					instructions: instructions.trim() || null,
					documentParts,
					temperature,
					abortSignal,
				});

	return parseExtractionResult(generated.response, schema);
}

export async function generateSchemaWithModel({
	document,
	annotations,
	annotationsMode,
	temperature,
}: SchemaModelInput): Promise<{
	readonly template: Record<string, unknown>;
	readonly raw: string;
	readonly pages: number | null;
}> {
	const documentParts = await documentContentParts(document);
	const guidance = schemaPrompt(annotations, annotationsMode);
	let generated: { readonly response: string };
	if (extractionRenderer() === "generic") {
		generated = await generateWithGenericJsonPrompt({
			instructions:
				"Propose a compact FREE Extraction Schema grounded in the supplied Source Document. " +
				"Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.",
			request: guidance,
			documentParts: documentParts.parts,
			temperature,
		});
	} else {
		generated = await generateWithNuExtractRawPrompt({
			mode: "template-generation",
			instructions: null,
			documentParts: [{ type: "text", text: guidance }, ...documentParts.parts],
			temperature,
		});
	}
	const template = await parseTemplate(generated.response);

	return {
		template,
		raw: generated.response,
		pages: documentParts.pages ?? document.pages,
	};
}

async function generateWithGenericJsonPrompt({
	instructions,
	request,
	documentParts,
	temperature,
	abortSignal,
}: {
	readonly instructions: string;
	readonly request: string | null;
	readonly documentParts: readonly DocumentContentPart[];
	readonly temperature?: number;
	readonly abortSignal?: AbortSignal;
}): Promise<{ readonly response: string }> {
	try {
		const model = resolveModel();
		const generated = await generateText({
			model,
			output: Output.json(),
			instructions,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: request
								? `${request}\n\nSOURCE DOCUMENT:\n`
								: "SOURCE DOCUMENT:\n",
						},
						...documentParts,
						{
							type: "text",
							text: "\nEND SOURCE DOCUMENT\n\nReturn the JSON object now.",
						},
					],
				},
			],
			abortSignal,
			// Codex CLI does not support temperature and warns even when the caller supplies one.
			...(model.provider === "codex-app-server"
				? {}
				: { temperature: temperature ?? 0 }),
		});
		return { response: generated.text };
	} catch (error) {
		if (NoObjectGeneratedError.isInstance(error) && error.text) {
			return { response: error.text };
		}
		throw error;
	}
}

async function generateWithNuExtractRawPrompt({
	mode,
	template,
	instructions,
	documentParts,
	temperature,
	abortSignal,
}: {
	readonly mode: NuExtractMode;
	readonly template?: string;
	readonly instructions: string | null;
	readonly documentParts: readonly DocumentContentPart[];
	readonly temperature?: number;
	readonly abortSignal?: AbortSignal;
}): Promise<{ readonly response: string }> {
	const rendered = renderNuExtractPrompt({
		mode,
		template,
		instructions,
		documentParts,
	});
	const numCtx = ollamaNumCtx();
	const response = await fetch(ollamaGenerateUrl(), {
		method: "POST",
		headers: ollamaHeaders(),
		signal: abortSignal,
		body: JSON.stringify({
			model: process.env.AI_MODEL || DEFAULT_MODEL,
			prompt: rendered.prompt,
			images: rendered.images.length > 0 ? rendered.images : undefined,
			raw: true,
			stream: false,
			options: {
				temperature: temperature ?? NON_THINKING_TEMPERATURE,
				...(numCtx === null ? {} : { num_ctx: numCtx }),
			},
		}),
	});

	const bodyText = await response.text();
	if (!response.ok) {
		throw new RequestError(
			response.status,
			"Ollama generation failed.",
			bodyText || null,
		);
	}

	const parsed = ollamaGenerateResponseSchema.safeParse(
		await parseUnknownJson(bodyText, "Ollama returned invalid JSON."),
	);
	if (!parsed.success) {
		throw new RequestError(
			502,
			"Ollama returned an unexpected generation response.",
			bodyText,
		);
	}
	return { response: parsed.data.response };
}

const ollamaGenerateResponseSchema = z.object({
	response: z.string(),
});

function renderNuExtractPrompt({
	mode,
	template,
	instructions,
	documentParts,
}: {
	readonly mode: NuExtractMode;
	readonly template?: string;
	readonly instructions: string | null;
	readonly documentParts: readonly DocumentContentPart[];
}): { readonly prompt: string; readonly images: readonly string[] } {
	const images: string[] = [];
	let prompt = "<|im_start|>user\n";
	prompt += `【task】${mode.replaceAll("-", " ")}\n`;
	if (template) {
		prompt += `【template_start】${template}【template_end】\n`;
		if (instructions) {
			prompt += `【instructions_start】${instructions}【instructions_end】\n`;
		}
	}
	prompt += "【document_start】\n";
	for (const part of documentParts) {
		if (part.type === "text") {
			prompt += `${part.text.trim()}\n`;
		} else {
			images.push(imageData(part));
			prompt += `${IMAGE_PLACEHOLDER}\n`;
		}
	}
	prompt +=
		"【document_end】<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
	return { prompt, images };
}

function imageData(part: DocumentFilePart): string {
	if (typeof part.data === "string") {
		const [, base64] = part.data.split(",", 2);
		return base64 ?? part.data;
	}
	return Buffer.from(part.data).toString("base64");
}

function ollamaNumCtx(): number | null {
	const value = process.env.AI_NUM_CTX;
	if (value === undefined) return null;
	if (!/^[0-9]+$/.test(value)) {
		throw new RequestError(500, "AI_NUM_CTX must be a positive safe integer.");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new RequestError(500, "AI_NUM_CTX must be a positive safe integer.");
	}
	return parsed;
}

function ollamaGenerateUrl(): string {
	const baseURL = (process.env.AI_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(
		/\/$/,
		"",
	);
	return baseURL.endsWith("/api")
		? `${baseURL}/generate`
		: `${baseURL}/api/generate`;
}

function ollamaHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (process.env.AI_API_KEY) {
		headers.authorization = `Bearer ${process.env.AI_API_KEY}`;
	}
	return headers;
}

export async function editSchemaWithModel(
  currentTemplate: unknown,
  instruction: string,
  abortSignal?: AbortSignal,
): Promise<SchemaOp[]> {
  const schemaJson = JSON.stringify(currentTemplate, null, 2)
  const prompt = `You are a schema editing assistant for humanities researchers.

Current extraction schema (JSON):
${schemaJson}

Researcher instruction: "${instruction}"

Return operations matching the requested structured output. No explanation, no markdown fences, no extra text.
Each operation must be one of:
  {"op":"add","name":"fieldName","type":"${SCHEMA_FIELD_TYPES.join('|')}","parentName":"optionalParent"}
  {"op":"remove","name":"fieldName","parentName":"optionalParent"}
  {"op":"patch","name":"fieldName","newName":"optionalNewName","type":"optionalNewType","parentName":"optionalParent"}

Rules:
- Only change what the researcher explicitly asked for
- Use parentName when the same field name exists at multiple nesting levels
- Omit parentName when the field is uniquely named
- Return an empty ops collection if no changes are needed`

  if (extractionRenderer() === 'generic') {
    const generated = await generateText({
      model: resolveModel(),
      output: Output.array({ element: editSchemaOpSchema, name: 'schema_operations' }),
      instructions: prompt,
      prompt: 'Return the schema operation array now.',
      abortSignal,
    })
    return parseSchemaOps(normalizeSchemaOps(generated.output))
  }
  const generated = await generateWithNuExtractRawPrompt({
    mode: 'structured',
    template: JSON.stringify(EDIT_SCHEMA_TEMPLATE),
    instructions: prompt,
    documentParts: [],
    abortSignal,
  })
  const text = generated.response.replace(/```(?:json)?|```/g, '').trim()
  const parsed = await parseUnknownJson(text, 'Edit schema model returned invalid JSON.')
  return parseSchemaOps(normalizeSchemaOps(isRecordWithOps(parsed) ? parsed.ops : parsed))
}

const editSchemaOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), name: z.string().min(1), type: z.enum(SCHEMA_FIELD_TYPES), parentName: z.string().optional() }),
  z.object({ op: z.literal('remove'), name: z.string().min(1), parentName: z.string().optional() }),
  z.object({ op: z.literal('patch'), name: z.string().min(1), newName: z.string().optional(), type: z.enum(SCHEMA_FIELD_TYPES).optional(), parentName: z.string().optional() }).refine(value => value.newName !== undefined || value.type !== undefined),
])

const EDIT_SCHEMA_TEMPLATE = {
  ops: [{ op: '', name: '', type: '', newName: '', parentName: '' }],
}

function normalizeSchemaOps(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return candidate
    const raw = candidate as Record<string, unknown>
    const optional = (key: 'parentName' | 'newName') =>
      typeof raw[key] === 'string' && raw[key].trim() ? raw[key] : undefined
    const parentName = optional('parentName')
    if (raw.op === 'remove') return { op: raw.op, name: raw.name, ...(parentName ? { parentName } : {}) }
    if (raw.op === 'add') return { op: raw.op, name: raw.name, type: raw.type, ...(parentName ? { parentName } : {}) }
    if (raw.op === 'patch') {
      const newName = optional('newName')
      const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type : undefined
      return { op: raw.op, name: raw.name, ...(newName ? { newName } : {}), ...(type ? { type } : {}), ...(parentName ? { parentName } : {}) }
    }
    return candidate
  })
}

function isRecordWithOps(value: unknown): value is { ops: unknown } {
  return typeof value === 'object' && value !== null && 'ops' in value
}
