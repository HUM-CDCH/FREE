import { describe, expect, it } from "vitest";
import { extractArticle } from "./_article.js";
import type { ExtractionSchemaEnvelope } from "./_catalog.js";
import {
	normalizeEmbeddedEvidence,
	type CanonicalEvidenceDocument,
} from "./_evidence_template.js";
import { generateStructuredWithModel } from "./_model.js";

const runLiveSmoke = process.env.RUN_ARTICLE_SMOKE === "1";

const schema: ExtractionSchemaEnvelope = {
	record: {
		paper_title: "",
		entries: [
			{
				scientific_name: "",
				measurement: "",
				_evidence: {
					measurement: {
						snippets: [""],
						inferred: false,
						source_type: "",
						page: 0,
						table_index: 0,
						row_index: 0,
						col_index: 0,
						row_header_text: "",
						column_header_text: "",
					},
				},
			},
		],
	},
	_schema_metadata: {
		"record.entries": {
			instance_description:
				"Extract one entry for the explicitly named species and its measurement.",
		},
	},
};

const document: CanonicalEvidenceDocument = {
	markdown:
		"# Collagen study\n\nThe sample is Gadus morhua. The canonical table reports its value.",
	pages: [
		{
			page: 1,
			text: "Collagen study. The sample is Gadus morhua. The canonical table reports 42 mg.",
			char_span: { llm_markdown_start: 0, llm_markdown_end: 84 },
		},
	],
	tables: [
		{
			table_id: "table-1",
			page_number: 1,
			cells: [
				{ row: 0, col: 0, text: "Species", role: "column_header" },
				{ row: 0, col: 1, text: "Measurement", role: "column_header" },
				{ row: 1, col: 0, text: "Gadus morhua", role: "row_header" },
				{ row: 1, col: 1, text: "42 mg", role: "data" },
			],
		},
	],
	anchors: [],
};

describe.skipIf(!runLiveSmoke)("live Article provider smoke", () => {
	it("returns schema-shaped values with canonical table Evidence", async () => {
		const extracted = await extractArticle({
			document: document.markdown,
			tables: document.tables,
			schema,
			generate: generateStructuredWithModel,
		});
		const result = normalizeEmbeddedEvidence(
			extracted.result,
			document,
			"article",
		);
		const entries = result.entries as Array<Record<string, unknown>>;
		const evidence = (
			entries[0]?._evidence as
				| Record<string, Record<string, unknown>>
				| undefined
		)?.measurement;

		expect(result).toHaveProperty("paper_title");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual(
			expect.objectContaining({
				scientific_name: "Gadus morhua",
				measurement: "42 mg",
			}),
		);
		expect(evidence).toEqual(
			expect.objectContaining({
				page: 1,
				table_index: 1,
				row_index: 1,
				col_index: 1,
			}),
		);
	}, 120_000);
});
