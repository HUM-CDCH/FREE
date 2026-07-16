import { extractArticle } from "./_article.js";
import { extractCatalog } from "./_catalog.js";
import {
	normalizeEmbeddedEvidence,
	type CanonicalEvidenceDocument,
	type CanonicalEvidencePage,
	type CanonicalEvidenceTable,
} from "./_evidence_template.js";
import { readExtractionRequest } from "./_extraction_request.js";
import { json, modelError, RequestError } from "./_http.js";
import {
	generateStructuredWithModel,
	type StructuredModelInput,
} from "./_model.js";

const DEFAULT_PARSING_SERVICE_URL = "http://127.0.0.1:8000";
const EXTRACTION_TIMEOUT_MS = 240_000;

type CanonicalDocument = CanonicalEvidenceDocument & {
	readonly markdown: string;
};

export async function POST(request: Request): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS);
	try {
		const abortSignal = AbortSignal.any([request.signal, timeoutSignal]);
		const input = await readExtractionRequest(request);
		abortSignal.throwIfAborted();
		const document = await fetchCanonicalDocument(input.taskId, abortSignal);
		const generate = (modelInput: StructuredModelInput) =>
			generateStructuredWithModel({ ...modelInput, abortSignal });
		const extraction =
			input.strategy === "catalog"
				? await extractCatalog({
						document: document.markdown,
						schema: input.schema,
						generate,
						abortSignal,
					})
				: await extractArticle({
						document: document.markdown,
						schema: input.schema,
						generate,
					});

		return json({
			result: normalizeEmbeddedEvidence(
				extraction.result,
				document,
				input.strategy === "catalog" ? "section" : "document",
			),
			warnings: [...extraction.warnings],
		});
	} catch (error) {
		if (timeoutSignal.aborted) {
			return json({ detail: "Extraction timed out." }, { status: 504 });
		}
		return modelError(error);
	}
}

function parseCanonicalDocument(value: unknown): CanonicalDocument {
	if (!isRecord(value) || value.schema_version !== "parsed_document.v1") {
		throw new RequestError(
			502,
			"Parsing service returned an unsupported canonical document; expected 'parsed_document.v1'.",
		);
	}
	if (
		!isRecord(value.text_views) ||
		typeof value.text_views.llm_markdown !== "string"
	) {
		throw new RequestError(
			502,
			"Canonical document is missing text_views.llm_markdown.",
		);
	}
	if (!Array.isArray(value.pages)) {
		throw new RequestError(502, "Canonical document is missing pages.");
	}
	if (!Array.isArray(value.tables)) {
		throw new RequestError(502, "Canonical document is missing tables.");
	}

	const pages = value.pages.map(parsePage);
	const tables = value.tables.map(parseTable);
	let anchors: Record<string, unknown>[] = [];
	if (value.evidence_index !== null && value.evidence_index !== undefined) {
		if (
			!isRecord(value.evidence_index) ||
			!Array.isArray(value.evidence_index.anchors)
		) {
			throw new RequestError(
				502,
				"Canonical document has an invalid evidence_index.anchors field.",
			);
		}
		if (!value.evidence_index.anchors.every(isRecord)) {
			throw new RequestError(
				502,
				"Canonical document contains an invalid Evidence Anchor.",
			);
		}
		anchors = value.evidence_index.anchors;
	}

	return {
		markdown: value.text_views.llm_markdown,
		pages,
		tables,
		anchors,
	};
}

async function fetchCanonicalDocument(
	taskId: string,
	abortSignal: AbortSignal,
): Promise<CanonicalDocument> {
	const baseUrl = parsingServiceUrl();
	let response: Response;
	try {
		response = await fetch(
			`${baseUrl}/tasks/${encodeURIComponent(taskId)}/parsed-document`,
			{
				headers: { accept: "application/json" },
				signal: abortSignal,
			},
		);
	} catch (error) {
		abortSignal.throwIfAborted();
		throw new RequestError(
			502,
			`Could not reach the parsing service: ${error instanceof Error ? error.message : "request failed"}`,
		);
	}

	const text = await response.text();
	const body = parseJsonText(text);
	if (!response.ok) {
		const detail =
			isRecord(body) && typeof body.detail === "string"
				? body.detail
				: `Parsing service request failed (HTTP ${response.status}).`;
		let status = 502;
		if (response.status === 404) status = 404;
		else if (response.status === 400) status = 409;
		throw new RequestError(status, detail);
	}
	return parseCanonicalDocument(body);
}

function parsePage(value: unknown, index: number): CanonicalEvidencePage {
	if (
		!isRecord(value) ||
		!positiveInteger(value.page) ||
		typeof value.text !== "string"
	) {
		throw new RequestError(
			502,
			`Canonical document contains an invalid page at index ${index}.`,
		);
	}
	if (
		value.markdown !== null &&
		value.markdown !== undefined &&
		typeof value.markdown !== "string"
	) {
		throw new RequestError(
			502,
			`Canonical page ${value.page} has invalid markdown.`,
		);
	}
	if (
		value.char_span !== null &&
		value.char_span !== undefined &&
		!isRecord(value.char_span)
	) {
		throw new RequestError(
			502,
			`Canonical page ${value.page} has an invalid char_span.`,
		);
	}
	return {
		page: value.page,
		text: value.text,
		markdown: value.markdown as string | null | undefined,
		char_span: value.char_span as Record<string, unknown> | null | undefined,
	};
}

function parseTable(value: unknown, index: number): CanonicalEvidenceTable {
	if (
		!isRecord(value) ||
		typeof value.table_id !== "string" ||
		!positiveInteger(value.page_number) ||
		!Array.isArray(value.cells)
	) {
		throw new RequestError(
			502,
			`Canonical document contains an invalid table at index ${index}.`,
		);
	}
	const cells = value.cells.map((cell, cellIndex) => {
		if (
			!isRecord(cell) ||
			!nonNegativeInteger(cell.row) ||
			!nonNegativeInteger(cell.col) ||
			typeof cell.text !== "string" ||
			(cell.role !== null &&
				cell.role !== undefined &&
				typeof cell.role !== "string")
		) {
			throw new RequestError(
				502,
				`Canonical table ${value.table_id} contains an invalid cell at index ${cellIndex}.`,
			);
		}
		return {
			row: cell.row,
			col: cell.col,
			text: cell.text,
			role: cell.role as string | null | undefined,
		};
	});
	return {
		table_id: value.table_id,
		page_number: value.page_number,
		cells,
	};
}

function parsingServiceUrl(): string {
	return (
		process.env.PARSING_SERVICE_URL ||
		process.env.VITE_PARSING_SERVICE_URL ||
		DEFAULT_PARSING_SERVICE_URL
	).replace(/\/$/, "");
}

function parseJsonText(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
