export type CanonicalEvidencePage = {
	readonly page: number;
	readonly text: string;
	readonly markdown?: string | null;
	readonly char_span?: Record<string, unknown> | null;
};

type CanonicalEvidenceCell = {
	readonly row: number;
	readonly col: number;
	readonly text: string;
	readonly role?: string | null;
};

export type CanonicalEvidenceTable = {
	readonly table_id: string;
	readonly page_number: number;
	readonly cells: readonly CanonicalEvidenceCell[];
};

export type CanonicalEvidenceDocument = {
	readonly pages: readonly CanonicalEvidencePage[];
	readonly tables: readonly CanonicalEvidenceTable[];
	readonly anchors: readonly Record<string, unknown>[];
};

const TABLE_NUMBER_FIELDS = ["table_index", "row_index", "col_index"] as const;
const TABLE_TEXT_FIELDS = ["row_header_text", "column_header_text"] as const;
const ELLIPSIS = /\s*(?:\.{3,}|…)\s*/;

export function normalizeEmbeddedEvidence(
	result: Record<string, unknown>,
	document: CanonicalEvidenceDocument,
): Record<string, unknown> {
	const normalized = structuredClone(result);
	normalizeNode(normalized, document);
	return normalized;
}

function normalizeNode(
	node: unknown,
	document: CanonicalEvidenceDocument,
): void {
	if (Array.isArray(node)) {
		node.forEach((item) => normalizeNode(item, document));
		return;
	}
	if (!isRecord(node)) return;

	const evidence = node._evidence;
	if (isRecord(evidence)) {
		for (const [field, evidenceNode] of Object.entries(evidence)) {
			normalizeEvidenceTree(evidenceNode, node[field], document);
		}
	}

	for (const [key, value] of Object.entries(node)) {
		if (key !== "_evidence") normalizeNode(value, document);
	}
}

function normalizeEvidenceTree(
	evidence: unknown,
	fieldValue: unknown,
	document: CanonicalEvidenceDocument,
): void {
	if (!isRecord(evidence)) return;
	if (isEvidenceLeaf(evidence)) {
		normalizeEvidenceLeaf(evidence, fieldValue, document);
		return;
	}
	for (const child of Object.values(evidence)) {
		normalizeEvidenceTree(child, fieldValue, document);
	}
}

function normalizeEvidenceLeaf(
	evidence: Record<string, unknown>,
	fieldValue: unknown,
	document: CanonicalEvidenceDocument,
): void {
	evidence.snippets = splitSnippets(evidence.snippets);
	const sourceType = stringValue(evidence.source_type).trim().toLowerCase();

	if (sourceType === "text") {
		clearTableFields(evidence);
		const page = resolveTextPage(evidence.snippets, document);
		if (page !== null) evidence.page = page;
		return;
	}

	const tableMatch = findTableMatch(evidence, fieldValue, document.tables);
	if (tableMatch) {
		Object.assign(evidence, tableMatch);
		return;
	}

	const page = resolveTextPage(evidence.snippets, document);
	if (page !== null && sourceType !== "table") {
		evidence.source_type = "text";
		evidence.page = page;
		clearTableFields(evidence);
	}
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

function findTableMatch(
	evidence: Record<string, unknown>,
	fieldValue: unknown,
	tables: readonly CanonicalEvidenceTable[],
): Record<string, unknown> | null {
	const sourceType = stringValue(evidence.source_type).trim().toLowerCase();
	if (sourceType === "text") return null;

	const hintedTable = positiveInteger(evidence.table_index);
	const hintedPage = positiveInteger(evidence.page);
	const hintedRow = nonNegativeInteger(evidence.row_index);
	const hintedCol = nonNegativeInteger(evidence.col_index);
	const snippets = Array.isArray(evidence.snippets)
		? evidence.snippets.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const tableTokens = snippets
		.map(tableSnippetTokens)
		.filter((tokens) => tokens.length > 0);
	const shouldMatch =
		sourceType === "table" ||
		hintedTable !== null ||
		hintedRow !== null ||
		hintedCol !== null ||
		tableTokens.length > 0;
	if (!shouldMatch) return null;

	const contexts = tables.map((table, index) => ({
		table,
		tableIndex: index + 1,
	}));
	const hintedContexts = contexts.filter(
		({ table, tableIndex }) =>
			(hintedTable === null || hintedTable === tableIndex) &&
			(hintedPage === null || hintedPage === table.page_number),
	);
	const selectedContexts =
		hintedContexts.length > 0 ? hintedContexts : contexts;
	const fieldText = normalizeText(scalarText(fieldValue));
	const candidates: Array<{
		readonly tableIndex: number;
		readonly table: CanonicalEvidenceTable;
		readonly cell: CanonicalEvidenceCell;
		readonly score: number;
	}> = [];

	if (hintedTable !== null && hintedRow !== null && hintedCol !== null) {
		for (const context of selectedContexts) {
			if (context.tableIndex !== hintedTable) continue;
			const cell = context.table.cells.find(
				(candidate) =>
					candidate.row === hintedRow && candidate.col === hintedCol,
			);
			if (!cell) continue;
			const cellText = normalizeText(cell.text);
			if (fieldText && !textsMatch(fieldText, cellText)) continue;
			candidates.push({ ...context, cell, score: 20 });
		}
	}

	for (const context of selectedContexts) {
		const rows = new Map<number, CanonicalEvidenceCell[]>();
		for (const cell of context.table.cells) {
			const row = rows.get(cell.row) ?? [];
			row.push(cell);
			rows.set(cell.row, row);
		}
		for (const tokens of tableTokens) {
			for (const row of rows.values()) {
				const overlap = tokens.filter((token) =>
					row.some((cell) => textsMatch(token, normalizeText(cell.text))),
				).length;
				if (overlap < 2) continue;
				for (const cell of row) {
					const cellText = normalizeText(cell.text);
					if (!cellText || (fieldText && !textsMatch(fieldText, cellText)))
						continue;
					let score = overlap * 5;
					if (fieldText) score += fieldText === cellText ? 6 : 3;
					if (cell.role === "data") score += 1;
					if (hintedTable === context.tableIndex) score += 2;
					if (hintedPage === context.table.page_number) score += 1;
					candidates.push({ ...context, cell, score });
				}
			}
		}
	}

	if (
		fieldText &&
		(sourceType === "table" || hintedTable !== null || hintedPage !== null)
	) {
		for (const context of selectedContexts) {
			for (const cell of context.table.cells) {
				const cellText = normalizeText(cell.text);
				if (!cellText || !textsMatch(fieldText, cellText)) continue;
				let score = 9;
				if (fieldText === cellText) score += 2;
				if (cell.role === "data") score += 1;
				if (hintedTable === context.tableIndex) score += 2;
				if (hintedPage === context.table.page_number) score += 1;
				candidates.push({ ...context, cell, score });
			}
		}
	}

	candidates.sort(
		(left, right) =>
			right.score - left.score ||
			left.tableIndex - right.tableIndex ||
			left.cell.row - right.cell.row ||
			left.cell.col - right.cell.col,
	);
	const best = candidates[0];
	const second = candidates[1];
	if (!best || best.score < 9) return null;
	if (
		second &&
		best.score - second.score < 2 &&
		(best.tableIndex !== second.tableIndex ||
			best.cell.row !== second.cell.row ||
			best.cell.col !== second.cell.col)
	) {
		return null;
	}

	return {
		source_type: "table",
		page: best.table.page_number,
		table_index: best.tableIndex,
		row_index: best.cell.row,
		col_index: best.cell.col,
		row_header_text: rowHeader(best.table.cells, best.cell),
		column_header_text: columnHeader(best.table.cells, best.cell),
	};
}

function rowHeader(
	cells: readonly CanonicalEvidenceCell[],
	selected: CanonicalEvidenceCell,
): string {
	const prior = cells
		.filter(
			(cell) =>
				cell.row === selected.row &&
				cell.col < selected.col &&
				cell.text.trim(),
		)
		.sort((left, right) => left.col - right.col);
	const headers = prior.filter((cell) =>
		["row_header", "row_header_hint", "header"].includes(cell.role ?? ""),
	);
	return uniqueText(headers.length > 0 ? headers : prior);
}

function columnHeader(
	cells: readonly CanonicalEvidenceCell[],
	selected: CanonicalEvidenceCell,
): string {
	const prior = cells
		.filter(
			(cell) =>
				cell.col === selected.col &&
				cell.row < selected.row &&
				cell.text.trim(),
		)
		.sort((left, right) => left.row - right.row);
	const headers = prior.filter((cell) =>
		["header", "column_header"].includes(cell.role ?? ""),
	);
	return uniqueText(headers.length > 0 ? headers : prior);
}

function uniqueText(cells: readonly CanonicalEvidenceCell[]): string {
	return [
		...new Set(cells.map((cell) => cell.text.trim()).filter(Boolean)),
	].join(" | ");
}

function tableSnippetTokens(snippet: string): string[] {
	const separator = snippet.includes("|")
		? "|"
		: snippet.includes("\t")
			? "\t"
			: null;
	if (!separator) return [];
	return snippet
		.split(separator)
		.map(normalizeText)
		.filter((token) => token && token !== "↳");
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

function textsMatch(left: string, right: string): boolean {
	if (!left || !right) return false;
	if (left === right) return true;
	return (
		Math.min(left.length, right.length) >= 4 &&
		(left.includes(right) || right.includes(left))
	);
}

function normalizeText(value: string): string {
	return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function scalarText(value: unknown): string {
	return typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
		? String(value)
		: "";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: null;
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
