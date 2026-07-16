import { conformToSchema } from "./_model_output.js";

export type ExtractionSchemaEnvelope = {
	readonly record: Record<string, unknown>;
	readonly _schema_metadata: Record<string, unknown>;
};

type StructuredGenerationInput = {
	readonly document: string;
	readonly schema: Record<string, unknown>;
	readonly instructions: string;
};

export type StructuredGenerator = (
	input: StructuredGenerationInput,
) => Promise<Record<string, unknown>>;

type Boundary = {
	readonly recordId: string;
	readonly label: string;
	readonly startIndex: number;
	readonly endIndex: number;
	readonly pageStart: number;
	readonly pageEnd: number;
};

export type CatalogSection = Boundary & { readonly text: string };

export type CatalogExtraction = {
	readonly result: Record<string, unknown>;
	readonly warnings: readonly string[];
};

const PAGE_BREAK = "\n\n---\n\n";
const MAX_CATALOG_SECTIONS = 100;
const BOUNDARY_SCHEMA = {
	records: [
		{
			record_id: "",
			label: "",
			start_marker: "",
			end_marker: "",
			start_index: null,
			end_index: null,
			page_start: null,
			page_end: null,
		},
	],
};

export function inferPrimaryRepeatedArray(
	recordSchema: Record<string, unknown>,
	metadata: Record<string, unknown>,
): {
	readonly key: string;
	readonly itemSchema: Record<string, unknown>;
} | null {
	const candidates: Array<{
		readonly key: string;
		readonly itemSchema: Record<string, unknown>;
		readonly score: number;
		readonly order: number;
	}> = [];

	Object.entries(recordSchema).forEach(([key, value], order) => {
		if (key.startsWith("_") || !isObjectArraySchema(value)) return;
		const entry = metadata[`record.${key}`];
		const description = isRecord(entry) ? entry.instance_description : null;
		candidates.push({
			key,
			itemSchema: value[0],
			score: typeof description === "string" ? description.trim().length : 0,
			order,
		});
	});

	candidates.sort(
		(left, right) => right.score - left.score || left.order - right.order,
	);
	const selected = candidates[0];
	return selected
		? { key: selected.key, itemSchema: selected.itemSchema }
		: null;
}

export function metadataForItemPrefix(
	metadata: Record<string, unknown>,
	arrayKey: string,
): Record<string, unknown> {
	const prefix = `record.${arrayKey}[].`;
	const arrayPath = `record.${arrayKey}`;
	return Object.fromEntries(
		Object.entries(metadata).filter(
			([key]) => key === arrayPath || key.startsWith(prefix),
		),
	);
}

export function resolveCatalogBoundaries(
	document: string,
	raw: Record<string, unknown>,
): Boundary[] {
	const records = Array.isArray(raw.records)
		? raw.records.filter(isRecord)
		: [];
	const resolved: Boundary[] = [];

	records.forEach((record, index) => {
		const startMarker = boundaryString(record.start_marker);
		const suppliedStart = nonNegativeInteger(record.start_index);
		const startIndex = suppliedStart ?? findMarker(document, startMarker);
		if (startIndex < 0) return;

		let endIndex = document.length;
		const next = records[index + 1];
		if (next) {
			const suppliedNext = nonNegativeInteger(next.start_index);
			const nextStart =
				suppliedNext ?? findMarker(document, boundaryString(next.start_marker));
			if (nextStart > startIndex) endIndex = nextStart;
		} else {
			const endMarker = boundaryString(record.end_marker);
			const markerEnd = endMarker ? findMarker(document, endMarker) : -1;
			if (markerEnd > startIndex) endIndex = markerEnd;
		}

		resolved.push({
			recordId: boundaryString(record.record_id) || String(index),
			label: boundaryString(record.label),
			startIndex,
			endIndex,
			pageStart:
				positiveInteger(record.page_start) ??
				charIndexToPage(document, startIndex),
			pageEnd:
				positiveInteger(record.page_end) ??
				charIndexToPage(document, Math.max(0, endIndex - 1)),
		});
	});

	const seenStarts = new Set<number>();
	return resolved
		.sort((left, right) => left.startIndex - right.startIndex)
		.filter((boundary) => {
			if (seenStarts.has(boundary.startIndex)) return false;
			seenStarts.add(boundary.startIndex);
			return true;
		});
}

export function sliceCatalogSections(
	document: string,
	boundaries: readonly Boundary[],
): CatalogSection[] {
	return boundaries.map((boundary, index) => {
		const start = Math.max(0, boundary.startIndex);
		const next = boundaries[index + 1];
		const end = next ? Math.max(start, next.startIndex) : document.length;
		return { ...boundary, text: document.slice(start, end) };
	});
}

export function catalogFingerprint(item: unknown): string {
	if (!isRecord(item)) return stableStringify(item);
	const bag: Record<string, unknown> = {};
	for (const key of Object.keys(item).sort((left, right) =>
		left.localeCompare(right),
	)) {
		if (key.startsWith("_")) continue;
		const value = item[key];
		bag[key] = Array.isArray(value)
			? { __len__: value.length }
			: isRecord(value)
				? "__object__"
				: value;
	}
	return stableStringify(bag);
}

export function mergeCatalogOutputs(
	outputs: readonly Record<string, unknown>[],
	schema: ExtractionSchemaEnvelope,
	arrayKey: string,
): Record<string, unknown> {
	const empty = asRecord(conformToSchema({}, schema.record));
	const arraySchema = schema.record[arrayKey];
	const itemSchema = isObjectArraySchema(arraySchema) ? arraySchema[0] : null;
	const seen = new Set<string>();
	const items: Record<string, unknown>[] = [];

	for (const output of outputs) {
		const fingerprint = catalogFingerprint(output);
		if (seen.has(fingerprint)) continue;
		seen.add(fingerprint);
		items.push(
			itemSchema ? asRecord(conformToSchema(output, itemSchema)) : output,
		);
	}

	return asRecord(
		conformToSchema({ ...empty, [arrayKey]: items }, schema.record),
	);
}

export async function extractCatalog({
	document,
	schema,
	generate,
	abortSignal,
}: {
	readonly document: string;
	readonly schema: ExtractionSchemaEnvelope;
	readonly generate: StructuredGenerator;
	readonly abortSignal?: AbortSignal;
}): Promise<CatalogExtraction> {
	const selected = inferPrimaryRepeatedArray(
		schema.record,
		schema._schema_metadata,
	);
	if (!selected) {
		const generated = await generate({
			document,
			schema: schema.record,
			instructions: wholeRecordInstructions(schema._schema_metadata),
		});
		return {
			result: asRecord(conformToSchema(generated, schema.record)),
			warnings: [],
		};
	}

	const boundaryResult = await generate({
		document,
		schema: BOUNDARY_SCHEMA,
		instructions: boundaryInstructions(schema, selected.key),
	});
	const resolved = resolveCatalogBoundaries(document, boundaryResult);
	if (resolved.length > MAX_CATALOG_SECTIONS) {
		throw new RangeError(
			`Catalog section count ${resolved.length} exceeds the limit; maximum is ${MAX_CATALOG_SECTIONS}`,
		);
	}
	const usedFallback = resolved.length === 0;
	const sections = usedFallback
		? [fallbackSection(document)]
		: sliceCatalogSections(document, resolved);
	const itemMetadata = metadataForItemPrefix(
		schema._schema_metadata,
		selected.key,
	);
	const items: Record<string, unknown>[] = [];
	const failed = new Set<number>();

	for (const [index, section] of sections.entries()) {
		try {
			const generated = await generate({
				document: section.text,
				schema: selected.itemSchema,
				instructions: itemInstructions(itemMetadata, false),
			});
			items.push(asRecord(conformToSchema(generated, selected.itemSchema)));
		} catch {
			abortSignal?.throwIfAborted();
			items.push(asRecord(conformToSchema({}, selected.itemSchema)));
			failed.add(index);
		}
	}

	const suspicious = detectSuspiciousRecords(
		sections,
		items,
		selected.itemSchema,
	);
	for (const index of new Set([...failed, ...suspicious])) {
		const section = sections[index];
		if (!section) continue;
		try {
			const generated = await generate({
				document: section.text,
				schema: selected.itemSchema,
				instructions: itemInstructions(itemMetadata, true),
			});
			items[index] = asRecord(conformToSchema(generated, selected.itemSchema));
		} catch {
			abortSignal?.throwIfAborted();
			// Reference behavior keeps the first failed/conformed value after retry exhaustion.
		}
	}

	return {
		result: mergeCatalogOutputs(items, schema, selected.key),
		warnings: usedFallback ? ["boundary_fallback"] : [],
	};
}

function detectSuspiciousRecords(
	sections: readonly CatalogSection[],
	items: readonly Record<string, unknown>[],
	itemSchema: Record<string, unknown>,
): number[] {
	const suspicious = new Set<number>();
	const fingerprints: string[] = [];

	items.forEach((item, index) => {
		if (isMostlyEmpty(item, itemSchema)) suspicious.add(index);
		const fingerprint = catalogFingerprint(item);
		if (fingerprints.includes(fingerprint)) suspicious.add(index);
		fingerprints.push(fingerprint);

		const section = sections[index]?.text ?? "";
		for (const [key, value] of Object.entries(itemSchema)) {
			if (
				!key.startsWith("_") &&
				isObjectArraySchema(value) &&
				Array.isArray(item[key]) &&
				item[key].length === 0 &&
				pipeTableDataRows(section) >= 2
			) {
				suspicious.add(index);
			}
		}
	});

	return [...suspicious].sort((left, right) => left - right);
}

function isMostlyEmpty(
	item: Record<string, unknown>,
	itemSchema: Record<string, unknown>,
): boolean {
	return Object.entries(itemSchema)
		.filter(([key]) => !key.startsWith("_"))
		.every(([key, childSchema]) => {
			const value = item[key];
			if (Array.isArray(childSchema))
				return !Array.isArray(value) || value.length === 0;
			if (isRecord(childSchema))
				return !isRecord(value) || !Object.values(value).some(pythonTruthy);
			return (
				value === null ||
				value === "" ||
				(Array.isArray(value) && value.length === 0)
			);
		});
}

function pipeTableDataRows(section: string): number {
	let rows = 0;
	let inTable = false;
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) {
			inTable = false;
		} else if (/^\|\s*---/.test(trimmed)) {
			inTable = true;
		} else if (inTable) {
			rows += 1;
		}
	}
	return rows;
}

function fallbackSection(document: string): CatalogSection {
	return {
		recordId: "0",
		label: "",
		startIndex: 0,
		endIndex: document.length,
		pageStart: 1,
		pageEnd: 1,
		text: document,
	};
}

function boundaryInstructions(
	schema: ExtractionSchemaEnvelope,
	arrayKey: string,
): string {
	return [
		"You locate boundaries between repeated top-level records in a document. You do not extract field values or structured record data.",
		"Using the record shape and metadata, infer what one instance of the primary collection looks like. Find every occurrence in the complete document in reading order.",
		"For every instance, return a start_marker and end_marker: verbatim lines or short snippets that occur in the document and delimit that instance. The start marker is where the instance begins. The end marker is where the next instance begins, or a unique snippet at the end of the final instance.",
		"Do not treat internal subsection headings as new top-level records unless metadata says they start a new instance. Use a visible stable record_id when available and a human-readable heading as label.",
		`Primary repeated array: record.${arrayKey}`,
		`Record shape: ${JSON.stringify(summarizeRecordShape(schema.record))}`,
		`Metadata: ${JSON.stringify(boundaryMetadata(schema._schema_metadata, arrayKey))}`,
		"Return one JSON object only. Include every detected record in source order and use null for unknown indices or pages.",
	].join("\n\n");
}

function boundaryMetadata(
	metadata: Record<string, unknown>,
	arrayKey: string,
): Record<string, unknown> {
	const path = `record.${arrayKey}`;
	const entries = Object.entries(metadata)
		.filter(([key]) => key === path || key.startsWith(`${path}.`))
		.map(([key, value]) => {
			if (!isRecord(value) || !("instance_description" in value)) {
				return [key, value];
			}
			const description = String(value.instance_description ?? "");
			return [
				key,
				{
					instance_description:
						description.length <= 1200
							? description
							: `${description.slice(0, 1197)}...`,
				},
			];
		});
	return Object.fromEntries(entries);
}

function itemInstructions(
	metadata: Record<string, unknown>,
	retry: boolean,
): string {
	return [
		"Extract exactly one primary record from this document section. Match the supplied item schema exactly and return one JSON object only.",
		"Use only facts in the document section. Metadata descriptions and their examples are guidance, never source values: do not copy example identifiers or values from metadata.",
		`Metadata: ${JSON.stringify(metadata)}`,
		"Restore every schema key and fully enumerate nested arrays. Populate every schema-declared local _evidence slot from the supplied section text, following the Evidence shape declared in the schema. Do not add, rename, or create undeclared keys or evidence slots.",
		retry
			? "STRICT RETRY: the previous result failed or was suspicious. Re-read the section and do not return an almost-empty record."
			: null,
	]
		.filter((part): part is string => part !== null)
		.join("\n\n");
}

function wholeRecordInstructions(metadata: Record<string, unknown>): string {
	return [
		"Extract one whole-document record matching the supplied record schema.",
		`Metadata: ${JSON.stringify(metadata)}`,
		"Use only the supplied document. Populate every schema-declared local _evidence slot from the supplied source text, following the Evidence shape declared in the schema. Do not create undeclared evidence slots.",
	].join("\n\n");
}

function summarizeRecordShape(
	recordSchema: Record<string, unknown>,
): unknown[] {
	return Object.entries(recordSchema)
		.filter(([key]) => !key.startsWith("_"))
		.map(([name, value]) => {
			if (isObjectArraySchema(value)) {
				return {
					name,
					kind: "array_of_objects",
					item_keys: Object.keys(value[0]),
				};
			}
			if (isRecord(value))
				return { name, kind: "object", keys: Object.keys(value) };
			if (Array.isArray(value)) return { name, kind: "array_other" };
			return { name, kind: "scalar" };
		});
}

function charIndexToPage(document: string, index: number): number {
	return document.slice(0, Math.max(0, index)).split(PAGE_BREAK).length;
}

function findMarker(document: string, marker: string): number {
	if (!document || !marker) return -1;
	const exact = document.indexOf(marker);
	if (exact >= 0) return exact;

	const firstLine = marker.split("\n")[0]?.trim();
	if (!firstLine) return -1;
	let offset = 0;
	for (const line of document.split(/(?<=\n)/)) {
		if (line.trim() === firstLine) return offset;
		offset += line.length;
	}
	return -1;
}

function isObjectArraySchema(
	value: unknown,
): value is [Record<string, unknown>] {
	return Array.isArray(value) && value.length === 1 && isRecord(value[0]);
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

function boundaryString(value: unknown): string {
	return value ? String(value) : "";
}

function pythonTruthy(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string" || Array.isArray(value))
		return value.length > 0;
	if (isRecord(value)) return Object.keys(value).length > 0;
	return true;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, child) => {
		if (!isRecord(child)) return child;
		return Object.fromEntries(
			Object.keys(child)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, child[key]]),
		);
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
