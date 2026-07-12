import { createOllama, ollama } from "ai-sdk-ollama";
import { convertToModelMessages, streamText } from "ai";
import type { LanguageModel, UIMessage } from "ai";
import { z } from "zod";
import type { Annotation, AnnotationMode, DocumentInput } from "./_document.ts";
import { documentFileParts, type DocumentFilePart } from "./_pdf.ts";
import { schemaPrompt } from "./_schema.ts";
import { RequestError } from "./_http.ts";
import { groundExtractionResult } from "./_evidence_grounding.ts";
import {
	parseExtractionResult,
	parseTemplate,
	parseUnknownJson,
} from "./_model_output.ts";
import {
	partitionRepeatedMarkdownRecords,
	repeatedRecordsMixTableSchemas,
} from "./_record_sections.ts";

export {
	parseAnnotationMode,
	parseAnnotations,
	parseDocument,
} from "./_document.ts";
export { json, modelError, parseTemperature, RequestError } from "./_http.ts";

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const IMAGE_PLACEHOLDER = "<|vision_start|><|image_pad|><|vision_end|>";
// NuExtract recommends 0.2 for deterministic non-thinking work and 0.6 when
// reasoning is enabled for structurally ambiguous extraction.
const NON_THINKING_TEMPERATURE = 0.2;
const THINKING_TEMPERATURE = 0.6;

declare const process: {
	env: Record<string, string | undefined>;
};

export type ExtractModelInput = {
	readonly document: DocumentInput;
	readonly template: unknown;
	readonly instruction?: string;
	readonly temperature?: number;
	readonly enableThinking?: boolean;
};

export type SchemaModelInput = {
	readonly document: DocumentInput;
	readonly annotations: readonly Annotation[];
	readonly annotationsMode: AnnotationMode;
	readonly temperature?: number;
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

function model(): LanguageModel {
	const modelId = process.env.AI_MODEL || DEFAULT_MODEL;
	const baseURL = process.env.AI_BASE_URL;
	const apiKey = process.env.AI_API_KEY;

	if (baseURL) {
		return createOllama({
			baseURL,
			apiKey,
		})(modelId);
	}

	if (apiKey) {
		return createOllama({ apiKey })(modelId);
	}

	return ollama(modelId);
}

export async function streamChatWithModel(
	messages: readonly UIMessage[],
): Promise<Response> {
	const result = streamText({
		model: model(),
		instructions:
			"You help humanities researchers inspect source documents in FREE. If no source document content is attached, say that no document context is available before answering normally.",
		messages: await convertToModelMessages([...messages]),
	});

	return result.toUIMessageStreamResponse({
		onError: () => "Chat failed.",
	});
}

type ExtractModelResult = {
	readonly result: Record<string, unknown>;
	readonly evidence: Record<string, unknown> | null;
	readonly raw: string;
	readonly reasoning: null;
	readonly pages: number | null;
};

export async function extractWithModel({
	document,
	template,
	instruction,
	temperature,
	enableThinking = false,
}: ExtractModelInput): Promise<ExtractModelResult> {
	const repeatedArray = repeatedObjectArray(template);
	const sections =
		document.markdown && repeatedArray
			? partitionRepeatedMarkdownRecords(document.markdown)
			: null;
	if (sections && repeatedArray) {
		return extractRepeatedRecords({
			sections,
			arrayKey: repeatedArray.key,
			arrayTemplate: repeatedArray.template,
			instruction,
			temperature,
			enableThinking,
			pages: document.pages,
		});
	}

	const documentParts = await documentContentParts(document);
	const extracted = await extractStructured({
		template,
		instruction,
		temperature,
		enableThinking,
		documentParts: documentParts.parts,
		sourceText: document.markdown ?? undefined,
	});
	return {
		...extracted,
		reasoning: null,
		pages: documentParts.pages ?? document.pages,
	};
}

async function extractRepeatedRecords({
	sections,
	arrayKey,
	arrayTemplate,
	instruction,
	temperature,
	enableThinking,
	pages,
}: {
	readonly sections: readonly string[];
	readonly arrayKey: string;
	readonly arrayTemplate: readonly unknown[];
	readonly instruction?: string;
	readonly temperature?: number;
	readonly enableThinking: boolean;
	readonly pages: number | null;
}): Promise<ExtractModelResult> {
	const resultItems: unknown[] = [];
	const evidenceItems: unknown[] = [];
	const rawResponses: string[] = [];
	let hasEvidence = false;

	for (const section of sections) {
		const extractSection = (reasoning: boolean) =>
			extractStructured({
				template: { [arrayKey]: arrayTemplate },
				instruction,
				temperature: reasoning ? undefined : temperature,
				enableThinking: reasoning,
				documentParts: [{ type: "text", text: section }],
				sourceText: section,
			});
		const initial = await extractSection(false);
		const initialItems = requiredArray(initial.result[arrayKey], arrayKey);
		const needsReasoning =
			enableThinking && repeatedRecordsMixTableSchemas(section, initialItems);
		const extracted = needsReasoning ? await extractSection(true) : initial;
		const sectionItems = needsReasoning
			? requiredArray(extracted.result[arrayKey], arrayKey)
			: initialItems;
		const sectionEvidence = extracted.evidence?.[arrayKey];
		const sectionEvidenceItems = Array.isArray(sectionEvidence)
			? sectionEvidence
			: [];
		sectionItems.forEach((item, index) => {
			resultItems.push(item);
			const itemEvidence = sectionEvidenceItems[index] ?? null;
			evidenceItems.push(itemEvidence);
			hasEvidence ||= itemEvidence !== null;
		});
		rawResponses.push(
			needsReasoning
				? JSON.stringify({ initial: initial.raw, reasoned: extracted.raw })
				: extracted.raw,
		);
	}

	return {
		result: { [arrayKey]: resultItems },
		evidence: hasEvidence ? { [arrayKey]: evidenceItems } : null,
		raw: JSON.stringify(rawResponses),
		reasoning: null,
		pages,
	};
}

function requiredArray(value: unknown, key: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new RequestError(502, `Model result must contain an '${key}' array.`);
	}
	return value;
}

async function extractStructured({
	template,
	instruction,
	temperature,
	enableThinking,
	documentParts,
	sourceText,
}: {
	readonly template: unknown;
	readonly instruction?: string;
	readonly temperature?: number;
	readonly enableThinking: boolean;
	readonly documentParts: readonly DocumentContentPart[];
	readonly sourceText?: string;
}): Promise<Pick<ExtractModelResult, "result" | "evidence" | "raw">> {
	const extractionTemplate = template ?? {};
	const generated = await generateWithNuExtractRawPrompt({
		mode: "structured",
		template: JSON.stringify(extractionTemplate, null, 2),
		instructions: instruction?.trim() || null,
		documentParts,
		temperature,
		enableThinking,
	});
	const parsed = await parseExtractionResult(
		generated.response,
		extractionTemplate,
	);
	const grounded = sourceText
		? groundExtractionResult(parsed, sourceText)
		: { result: parsed, evidence: null };
	return {
		result: grounded.result,
		evidence: grounded.evidence,
		raw: generated.response,
	};
}

function repeatedObjectArray(
	template: unknown,
): { readonly key: string; readonly template: readonly unknown[] } | null {
	if (!isRecord(template)) return null;
	const entries = Object.entries(template);
	if (entries.length !== 1) return null;
	const [key, value] = entries[0];
	if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]))
		return null;
	return { key, template: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const generated = await generateWithNuExtractRawPrompt({
		mode: "template-generation",
		instructions: null,
		documentParts: [
			{ type: "text", text: schemaPrompt(annotations, annotationsMode) },
			...documentParts.parts,
		],
		temperature,
	});
	const template = await parseTemplate(generated.response);

	return {
		template,
		raw: generated.response,
		pages: documentParts.pages ?? document.pages,
	};
}

async function generateWithNuExtractRawPrompt({
	mode,
	template,
	instructions,
	documentParts,
	temperature,
	enableThinking = false,
}: {
	readonly mode: NuExtractMode;
	readonly template?: string;
	readonly instructions: string | null;
	readonly documentParts: readonly DocumentContentPart[];
	readonly temperature?: number;
	readonly enableThinking?: boolean;
}): Promise<{ readonly response: string }> {
	const rendered = renderNuExtractPrompt({
		mode,
		template,
		instructions,
		documentParts,
		enableThinking,
	});
	let response: Response;
	try {
		response = await fetch(ollamaGenerateUrl(), {
			method: "POST",
			headers: ollamaHeaders(),
			body: JSON.stringify({
				model: process.env.AI_MODEL || DEFAULT_MODEL,
				prompt: rendered.prompt,
				images: rendered.images.length > 0 ? rendered.images : undefined,
				raw: true,
				stream: false,
				options: {
					temperature:
						temperature ??
						(enableThinking ? THINKING_TEMPERATURE : NON_THINKING_TEMPERATURE),
					num_ctx: positiveInteger(process.env.AI_CONTEXT_LENGTH),
				},
			}),
		});
	} catch (error) {
		throw new RequestError(
			502,
			"Ollama generation failed.",
			error instanceof Error ? error.message : null,
		);
	}

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

function positiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new RequestError(
			500,
			"AI_CONTEXT_LENGTH must be a positive integer.",
		);
	}
	return parsed;
}

function renderNuExtractPrompt({
	mode,
	template,
	instructions,
	documentParts,
	enableThinking,
}: {
	readonly mode: NuExtractMode;
	readonly template?: string;
	readonly instructions: string | null;
	readonly documentParts: readonly DocumentContentPart[];
	readonly enableThinking: boolean;
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
	prompt += "【document_end】<|im_end|>\n<|im_start|>assistant\n<think>\n";
	if (!enableThinking) prompt += "\n</think>\n\n";
	return { prompt, images };
}

function imageData(part: DocumentFilePart): string {
	if (typeof part.data === "string") {
		const [, base64] = part.data.split(",", 2);
		return base64 ?? part.data;
	}
	return Buffer.from(part.data).toString("base64");
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
