export type ExtractionStrategy = "catalog" | "article";

export type CanonicalEvidenceCell = {
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

export type CanonicalTableAnchor = {
	readonly source_type: "table";
	readonly page: number;
	readonly table_index: number;
	readonly row_index: number;
	readonly col_index: number;
	readonly row_header_text: string;
	readonly column_header_text: string;
};

type Candidate = {
	readonly tableIndex: number;
	readonly table: CanonicalEvidenceTable;
	readonly cell: CanonicalEvidenceCell;
	readonly score: number;
};

export function matchCanonicalTableEvidence({
	evidence,
	fieldValue,
	tables,
	strategy,
}: {
	readonly evidence: Record<string, unknown>;
	readonly fieldValue: unknown;
	readonly tables: readonly CanonicalEvidenceTable[];
	readonly strategy: ExtractionStrategy;
}): CanonicalTableAnchor | null {
	const sourceType = stringValue(evidence.source_type).trim().toLowerCase();
	if (sourceType === "text") return null;

	// Catalog sees section-local coordinates, so they must not activate or
	// influence document-global canonical matching. Article coordinates are
	// document-global hints that may activate matching, but canonical matching
	// still owns the returned Evidence Anchor.
	const isArticle = strategy === "article";
	const modelTable = isArticle ? positiveInteger(evidence.table_index) : null;
	const modelRow = isArticle ? nonNegativeInteger(evidence.row_index) : null;
	const modelCol = isArticle ? nonNegativeInteger(evidence.col_index) : null;
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
		modelTable !== null ||
		modelRow !== null ||
		modelCol !== null ||
		tableTokens.length > 0;
	if (!shouldMatch) return null;

	const fieldText = normalizeText(scalarText(fieldValue));
	const contexts = tables.map((table, index) => ({
		table,
		tableIndex: index + 1,
	}));
	const candidates: Candidate[] = [];

	for (const context of contexts) {
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
					candidates.push({ ...context, cell, score });
				}
			}
		}
	}

	if (fieldText && (sourceType === "table" || modelTable !== null)) {
		for (const context of contexts) {
			for (const cell of context.table.cells) {
				const cellText = normalizeText(cell.text);
				if (!cellText || !textsMatch(fieldText, cellText)) continue;
				candidates.push({
					...context,
					cell,
					score:
						9 +
						(fieldText === cellText ? 2 : 0) +
						(cell.role === "data" ? 1 : 0),
				});
			}
		}
	}

	const byCell = new Map<string, Candidate>();
	for (const candidate of candidates) {
		const key = `${candidate.tableIndex}:${candidate.cell.row}:${candidate.cell.col}`;
		const current = byCell.get(key);
		if (!current || candidate.score > current.score) byCell.set(key, candidate);
	}
	const ranked = [...byCell.values()].sort(
		(left, right) =>
			right.score - left.score ||
			left.tableIndex - right.tableIndex ||
			left.cell.row - right.cell.row ||
			left.cell.col - right.cell.col,
	);
	const best = ranked[0];
	const second = ranked[1];
	if (!best || best.score < 9 || (second && best.score - second.score < 2))
		return null;

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

function textsMatch(left: string, right: string): boolean {
	if (!left || !right) return false;
	if (left === right) return true;
	return (
		Math.min(left.length, right.length) >= 4 &&
		(left.includes(right) || right.includes(left))
	);
}

export function normalizeText(value: string): string {
	return value
		.replace(/\u00a0/g, " ")
		.toLocaleLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function scalarText(value: unknown): string {
	return typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
		? String(value)
		: "";
}

export function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: null;
}
