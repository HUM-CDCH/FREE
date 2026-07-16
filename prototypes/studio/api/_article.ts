import {
	type ExtractionSchemaEnvelope,
	type StructuredGenerator,
} from "./_catalog.js";
import { conformToSchema } from "./_model_output.js";

export async function extractArticle({
	document,
	schema,
	tables = [],
	generate,
}: {
	readonly document: string;
	readonly schema: ExtractionSchemaEnvelope;
	readonly tables?: readonly CanonicalArticleTable[];
	readonly generate: StructuredGenerator;
}): Promise<{
	readonly result: Record<string, unknown>;
	readonly warnings: readonly string[];
}> {
	const generated = await generate({
		document: articleDocument(document, tables),
		schema: schema.record,
		instructions: [
			"Extract one whole-document Article record matching the supplied record schema.",
			`Metadata: ${JSON.stringify(schema._schema_metadata)}`,
			"Canonical table_index values are document-global and 1-based; table cell row and col coordinates are 0-based. Use these locations when populating table Evidence.",
			"Use only the canonical document and fully enumerate declared arrays. Populate every schema-declared local _evidence slot from the supplied source text, following the Evidence shape declared in the schema. Do not create undeclared evidence slots.",
		].join("\n\n"),
	});
	const conformed = conformToSchema(generated, schema.record);
	return {
		result: isRecord(conformed) ? conformed : {},
		warnings: [],
	};
}

type CanonicalArticleTable = {
	readonly page_number: number;
	readonly cells: readonly {
		readonly row: number;
		readonly col: number;
		readonly role?: string | null;
		readonly text: string;
	}[];
};

function articleDocument(
	document: string,
	tables: readonly CanonicalArticleTable[],
): string {
	if (tables.length === 0) return document;
	const inventory = tables.map((table, index) => ({
		table_index: index + 1,
		page: table.page_number,
		cells: table.cells.map(({ row, col, role, text }) => ({
			row,
			col,
			role: role ?? null,
			text,
		})),
	}));
	return `${document}\n\nCANONICAL TABLE INVENTORY:\n${JSON.stringify(inventory, null, 2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
