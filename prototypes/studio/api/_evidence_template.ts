import {
	matchCanonicalTableEvidence,
	nonNegativeInteger,
	normalizeText,
	positiveInteger,
	stringValue,
	type CanonicalEvidenceTable,
	type ExtractionStrategy,
} from "./_table_evidence.js";

export type CanonicalEvidencePage = {
	readonly page: number;
	readonly text: string;
	readonly markdown?: string | null;
	readonly char_span?: Record<string, unknown> | null;
};

export type { CanonicalEvidenceTable } from "./_table_evidence.js";

export type CanonicalEvidenceDocument = {
	readonly markdown: string;
	readonly pages: readonly CanonicalEvidencePage[];
	readonly tables: readonly CanonicalEvidenceTable[];
	readonly anchors: readonly Record<string, unknown>[];
};

type EvidenceNormalizationContext = {
	readonly document: CanonicalEvidenceDocument;
	readonly strategy: ExtractionStrategy;
};

const TABLE_NUMBER_FIELDS = ["table_index", "row_index", "col_index"] as const;
const TABLE_TEXT_FIELDS = ["row_header_text", "column_header_text"] as const;
const ELLIPSIS = /\s*(?:\.{3,}|…)\s*/;

export function normalizeEmbeddedEvidence(
	result: Record<string, unknown>,
	document: CanonicalEvidenceDocument,
	strategy: ExtractionStrategy,
): Record<string, unknown> {
	const normalized = structuredClone(result);
	normalizeNode(normalized, { document, strategy });
	return normalized;
}

function normalizeNode(
	node: unknown,
	context: EvidenceNormalizationContext,
): void {
	if (Array.isArray(node)) {
		node.forEach((item) => normalizeNode(item, context));
		return;
	}
	if (!isRecord(node)) return;

	const evidence = node._evidence;
	if (isRecord(evidence)) {
		for (const [field, evidenceNode] of Object.entries(evidence)) {
			normalizeEvidenceTree(evidenceNode, node[field], context);
		}
	}

	for (const [key, value] of Object.entries(node)) {
		if (key !== "_evidence") normalizeNode(value, context);
	}
}

function normalizeEvidenceTree(
	evidence: unknown,
	fieldValue: unknown,
	context: EvidenceNormalizationContext,
): void {
	if (!isRecord(evidence)) return;
	if (isEvidenceLeaf(evidence)) {
		normalizeEvidenceLeaf(evidence, fieldValue, context);
		return;
	}
	for (const child of Object.values(evidence)) {
		normalizeEvidenceTree(child, fieldValue, context);
	}
}

function normalizeEvidenceLeaf(
	evidence: Record<string, unknown>,
	fieldValue: unknown,
	context: EvidenceNormalizationContext,
): void {
	evidence.snippets = splitSnippets(evidence.snippets);
	const sourceType = stringValue(evidence.source_type).trim().toLowerCase();
	const suppliedPage = positiveInteger(evidence.page);
	const validSuppliedPage = context.document.pages.some(
		(page) => page.page === suppliedPage,
	)
		? suppliedPage
		: null;
	const hasTableIntent = tableIntent(evidence, sourceType);

	if (sourceType === "text") {
		clearTableFields(evidence);
		evidence.page =
			resolveTextPage(evidence.snippets, context.document) ??
			(Array.isArray(evidence.snippets) && evidence.snippets.length === 0
				? validSuppliedPage
				: null);
		return;
	}

	const tableMatch = matchCanonicalTableEvidence({
		evidence,
		fieldValue,
		tables: context.document.tables,
		strategy: context.strategy,
	});
	if (tableMatch) {
		Object.assign(evidence, tableMatch);
		return;
	}

	const page = resolveTextPage(evidence.snippets, context.document);
	if (page !== null && sourceType !== "table") {
		evidence.source_type = "text";
		evidence.page = page;
		clearTableFields(evidence);
		return;
	}

	evidence.page =
		!hasTableIntent &&
		Array.isArray(evidence.snippets) &&
		evidence.snippets.length === 0
			? validSuppliedPage
			: null;
	clearTableFields(evidence);
}

function tableIntent(
	evidence: Record<string, unknown>,
	sourceType: string,
): boolean {
	if (sourceType === "table") return true;
	if (positiveInteger(evidence.table_index) !== null) return true;
	if (nonNegativeInteger(evidence.row_index) !== null) return true;
	if (nonNegativeInteger(evidence.col_index) !== null) return true;
	return (
		Array.isArray(evidence.snippets) &&
		evidence.snippets.some(
			(snippet) =>
				typeof snippet === "string" &&
				(snippet.includes("|") || snippet.includes("\t")),
		)
	);
}

function splitSnippets(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const snippets: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const parts = item
			.split(ELLIPSIS)
			.map((part) => part.trim())
			.filter(Boolean);
		snippets.push(...(parts.length > 0 ? parts : [item]));
	}
	return snippets;
}

function resolveTextPage(
	snippetsValue: unknown,
	document: CanonicalEvidenceDocument,
): number | null {
	const snippets = Array.isArray(snippetsValue)
		? snippetsValue.filter(
				(item): item is string => typeof item === "string" && item.length > 0,
			)
		: [];

	for (const snippet of snippets) {
		for (const page of document.pages) {
			const span = page.char_span;
			const start = isRecord(span)
				? nonNegativeInteger(span.llm_markdown_start)
				: null;
			const end = isRecord(span)
				? nonNegativeInteger(span.llm_markdown_end)
				: null;
			if (
				start !== null &&
				end !== null &&
				start <= end &&
				end <= document.markdown.length &&
				textContains(document.markdown.slice(start, end), snippet)
			) {
				return page.page;
			}
		}
		for (const page of document.pages) {
			if (
				textContains(page.markdown ?? page.text, snippet) ||
				textContains(page.text, snippet)
			) {
				return page.page;
			}
		}
		const anchorPage = pageFromAnchors(snippet, document);
		if (anchorPage !== null) return anchorPage;
	}
	return null;
}

function pageFromAnchors(
	snippet: string,
	document: CanonicalEvidenceDocument,
): number | null {
	for (const anchor of document.anchors) {
		const anchorText = [anchor.snippet, anchor.text, anchor.quote].find(
			(value): value is string => typeof value === "string",
		);
		if (!anchorText || !textContains(anchorText, snippet)) continue;

		const directPage =
			positiveInteger(anchor.page) ?? positiveInteger(anchor.page_number);
		if (directPage !== null) return directPage;

		const offset =
			nonNegativeInteger(anchor.llm_markdown_start) ??
			nonNegativeInteger(anchor.char_start) ??
			nonNegativeInteger(anchor.start);
		if (offset === null) continue;
		for (const page of document.pages) {
			const span = page.char_span;
			if (!isRecord(span)) continue;
			const start = nonNegativeInteger(span.llm_markdown_start);
			const end = nonNegativeInteger(span.llm_markdown_end);
			if (start !== null && end !== null && offset >= start && offset < end)
				return page.page;
		}
	}
	return null;
}

function clearTableFields(evidence: Record<string, unknown>): void {
	for (const field of TABLE_NUMBER_FIELDS) {
		if (field in evidence) evidence[field] = null;
	}
	for (const field of TABLE_TEXT_FIELDS) {
		if (field in evidence) evidence[field] = "";
	}
}

function textContains(text: string, snippet: string): boolean {
	const haystack = normalizeText(text);
	const needle = normalizeText(snippet);
	return needle.length > 0 && haystack.includes(needle);
}

function isEvidenceLeaf(value: Record<string, unknown>): boolean {
	return (
		"snippets" in value ||
		"source_type" in value ||
		"table_index" in value ||
		"page" in value
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
