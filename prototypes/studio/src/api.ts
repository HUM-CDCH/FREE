import { isRecord } from "./template";
import type { ExtractionSchemaEnvelope } from "../shared/schema";

export type { ExtractionSchemaEnvelope } from "../shared/schema";

export const API_BASE = "/api";

const PARSING_SERVICE_BASE: string =
	(import.meta.env.VITE_PARSING_SERVICE_URL as string | undefined) ??
	"http://127.0.0.1:8000";

const PARSE_POLL_MS = 1500;

type TemplateAnnotation = { text: string; pageNumber: number };
export type AnnotationsMode = "hints" | "fields";
export type ExtractionStrategy = "catalog" | "article";

export type ExtractionResponse = {
	readonly result: Record<string, unknown>;
	readonly warnings: readonly string[];
};

export type ParsedTaskDocument = {
	readonly taskId: string;
	readonly markdown: string;
};

type TemplateOptions = {
	annotations?: TemplateAnnotation[];
	annotationsMode?: AnnotationsMode;
	markdown?: string | null;
};

export type SchemaDone = {
	suggestionId: string;
	template: unknown;
	raw: string;
	pages: number | null;
};

type TaskStatus = { status: string; error?: string | null };

export function decodeSchemaDone(data: unknown): SchemaDone {
	if (
		!isRecord(data) ||
		!("template" in data) ||
		typeof data.suggestionId !== "string" ||
		!data.suggestionId
	) {
		throw new Error(
			"generate_schema: response missing 'template' or 'suggestionId' — API contract drift?",
		);
	}
	return data as SchemaDone;
}

export function decodeExtractionResponse(data: unknown): ExtractionResponse {
	if (!isRecord(data) || !isRecord(data.result)) {
		throw new Error(
			"extract: response missing or invalid 'result' — API contract drift?",
		);
	}
	if (
		!Array.isArray(data.warnings) ||
		!data.warnings.every((warning) => typeof warning === "string")
	) {
		throw new Error(
			"extract: response missing or invalid 'warnings' — API contract drift?",
		);
	}
	return { result: data.result, warnings: data.warnings };
}

export async function parseDocumentToMarkdown(
	file: Blob,
	fileName: string,
	signal?: AbortSignal,
): Promise<ParsedTaskDocument> {
	const form = new FormData();
	form.append("file", file, fileName);
	form.append("pipeline", "docling_pdf");

	const started = await fetch(`${PARSING_SERVICE_BASE}/tasks`, {
		method: "POST",
		body: form,
		signal,
	});
	if (!started.ok) {
		throw new Error(
			(await readErrorDetail(started)) ||
				`Parsing service rejected the document (HTTP ${started.status})`,
		);
	}
	const startedBody: unknown = await started.json();
	if (
		!isRecord(startedBody) ||
		typeof startedBody.task_id !== "string" ||
		!startedBody.task_id
	) {
		throw new Error(
			"Parsing service response missing 'task_id' — API contract drift?",
		);
	}
	const taskId = startedBody.task_id;

	await waitForParsingTask(taskId, signal);

	const markdownResponse = await fetch(
		`${PARSING_SERVICE_BASE}/tasks/${taskId}/markdown`,
		{ signal },
	);
	if (!markdownResponse.ok) {
		throw new Error(
			`Could not fetch parsed Markdown (HTTP ${markdownResponse.status})`,
		);
	}
	return { taskId, markdown: await markdownResponse.text() };
}

async function waitForParsingTask(
	taskId: string,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const response = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}`, {
		signal,
	});
	if (!response.ok)
		throw new Error(`Parsing status check failed (HTTP ${response.status})`);
	const metadata = (await response.json()) as TaskStatus;
	if (metadata.status === "completed") return;
	if (metadata.status === "failed")
		throw new Error(metadata.error || "Document parsing failed");
	await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_MS));
	return waitForParsingTask(taskId, signal);
}

export async function requestSchema(
	file: Blob,
	fileName: string,
	signal?: AbortSignal,
	options?: TemplateOptions,
): Promise<{ readonly id: string; readonly schema: ExtractionSchemaEnvelope }> {
	const form = new FormData();
	if (options?.markdown) {
		form.append("document_markdown", options.markdown);
	} else {
		form.append("file", file, fileName);
	}
	if (options?.annotations?.length) {
		form.append("annotations", JSON.stringify(options.annotations));
		form.append("annotations_mode", options.annotationsMode ?? "hints");
	}

	const response = await fetch(`${API_BASE}/generate_schema`, {
		method: "POST",
		body: form,
		headers: { accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		const detail = await readErrorDetail(response);
		throw new Error(
			detail || `Request to /generate_schema failed (HTTP ${response.status})`,
		);
	}
	const { suggestionId, template } = decodeSchemaDone(await response.json());
	if (!isRecord(template)) {
		throw new Error(
			"generate_schema: response 'template' must be an object — API contract drift?",
		);
	}
	return {
		id: suggestionId,
		schema: {
			name: "Generated from source document",
			description: "",
			record: template,
			_schema_metadata: {},
		},
	};
}

export async function requestExtraction(
	taskId: string,
	schema: ExtractionSchemaEnvelope,
	strategy: ExtractionStrategy,
	signal?: AbortSignal,
): Promise<ExtractionResponse> {
	if (!isRecord(schema.record) || !isRecord(schema._schema_metadata)) {
		throw new Error(
			"extract: schema must contain object fields 'record' and '_schema_metadata'",
		);
	}
	const response = await fetch(`${API_BASE}/extract`, {
		method: "POST",
		body: JSON.stringify({ taskId, schema, strategy }),
		headers: {
			accept: "application/json",
			"content-type": "application/json",
		},
		signal,
	});
	if (!response.ok) {
		const detail = await readErrorDetail(response);
		throw new Error(
			detail || `Request to /extract failed (HTTP ${response.status})`,
		);
	}
	return decodeExtractionResponse(await response.json());
}

async function readErrorDetail(response: Response): Promise<string> {
	const body = await response.json().catch(() => null);
	const detail = isRecord(body) ? body.detail : null;
	if (typeof detail === "string") return detail;
	if (isRecord(detail) && typeof detail.message === "string")
		return detail.message;
	return "";
}
