import { describe, expect, it } from "vitest";
import {
	normalizeEmbeddedEvidence,
	type CanonicalEvidenceDocument,
} from "./_evidence_template.js";

const canonicalPages = [
	"Introduction",
	"The reported length was 42.",
	"Appendix",
] as const;
const page2Start = canonicalPages[0].length;
const page3Start = page2Start + canonicalPages[1].length;

const document: CanonicalEvidenceDocument = {
	markdown: canonicalPages.join(""),
	pages: [
		{
			page: 1,
			text: canonicalPages[0],
			char_span: { llm_markdown_start: 0, llm_markdown_end: page2Start },
		},
		{
			page: 2,
			text: canonicalPages[1],
			char_span: {
				llm_markdown_start: page2Start,
				llm_markdown_end: page3Start,
			},
		},
		{
			page: 3,
			text: canonicalPages[2],
			char_span: {
				llm_markdown_start: page3Start,
				llm_markdown_end: page3Start + canonicalPages[2].length,
			},
		},
	],
	tables: [
		{
			table_id: "table-1",
			page_number: 2,
			cells: [
				{ row: 0, col: 0, text: "Parameter", role: "column_header" },
				{ row: 0, col: 1, text: "Value", role: "column_header" },
				{ row: 1, col: 0, text: "Length", role: "row_header" },
				{ row: 1, col: 1, text: "42", role: "data" },
			],
		},
	],
	anchors: [{ quote: "Anchor-only quotation", page: 3 }],
};

describe("normalizeEmbeddedEvidence", () => {
	it("retains nested local Evidence and splits ellipsis-glued snippets", () => {
		const result = {
			entries: [
				{
					fundliste: [
						{
							Fund_no: "8-2",
							_evidence: {
								Fund_no: {
									snippets: ["Fund 8-2 ... Jernspænde", "…"],
									inferred: false,
									source_type: "text",
									page: null,
									table_index: 1,
									row_index: 1,
									col_index: 1,
									row_header_text: "stale",
									column_header_text: "stale",
								},
							},
						},
					],
				},
			],
		};

		const normalized = normalizeEmbeddedEvidence(result, document);
		const evidence = (
			(
				(normalized.entries as Array<Record<string, unknown>>)[0]
					?.fundliste as Array<Record<string, unknown>>
			)[0]?._evidence as Record<string, Record<string, unknown>>
		).Fund_no;

		expect(evidence).toEqual(
			expect.objectContaining({
				snippets: ["Fund 8-2", "Jernspænde", "…"],
				table_index: null,
				row_index: null,
				col_index: null,
				row_header_text: "",
				column_header_text: "",
			}),
		);
		expect(normalized).not.toHaveProperty("evidence");
	});

	it("grounds text Evidence to canonical page text", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: ["reported length was 42"],
						source_type: "text",
						page: null,
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).length
				?.page,
		).toBe(2);
	});

	it("searches all canonical Markdown page slices before page-text fallbacks", () => {
		const canonical = [
			"First canonical page",
			"Canonical-only wording",
			"Appendix",
		] as const;
		const secondStart = canonical[0].length;
		const thirdStart = secondStart + canonical[1].length;
		const normalized = normalizeEmbeddedEvidence(
			{
				note: "Canonical-only wording",
				_evidence: {
					note: {
						snippets: ["canonical-only wording"],
						source_type: "text",
						page: null,
					},
				},
			},
			{
				...document,
				markdown: canonical.join(""),
				pages: [
					{
						page: 1,
						text: "Fallback text repeats canonical-only wording.",
						char_span: { llm_markdown_start: 0, llm_markdown_end: secondStart },
					},
					{
						page: 2,
						text: "Normalized page text",
						char_span: {
							llm_markdown_start: secondStart,
							llm_markdown_end: thirdStart,
						},
					},
					{
						page: 3,
						text: canonical[2],
						char_span: {
							llm_markdown_start: thirdStart,
							llm_markdown_end: thirdStart + canonical[2].length,
						},
					},
				],
			},
		);
		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).note
				?.page,
		).toBe(2);
	});

	it("uses optional anchors when page text does not contain the snippet", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				note: "Anchor-only quotation",
				_evidence: {
					note: {
						snippets: ["Anchor-only quotation"],
						source_type: "text",
						page: null,
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).note
				?.page,
		).toBe(3);
	});

	it("backfills deterministic table provenance while preserving table_index", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: ["| Length | 42 |"],
						source_type: "table",
						page: null,
						table_index: null,
						row_index: null,
						col_index: null,
						row_header_text: "",
						column_header_text: "",
					},
				},
			},
			document,
		);
		const evidence = (
			normalized._evidence as Record<string, Record<string, unknown>>
		).length;

		expect(evidence).toEqual(
			expect.objectContaining({
				source_type: "table",
				page: 2,
				table_index: 1,
				row_index: 1,
				col_index: 1,
				row_header_text: "Length",
				column_header_text: "Value",
			}),
		);
	});

	it("falls back to canonical tables when table and page hints are stale", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: ["| Length | 42 |"],
						source_type: "table",
						page: 99,
						table_index: 99,
						row_index: null,
						col_index: null,
					},
				},
			},
			document,
		);
		const evidence = (
			normalized._evidence as Record<string, Record<string, unknown>>
		).length;

		expect(evidence).toEqual(
			expect.objectContaining({
				page: 2,
				table_index: 1,
				row_index: 1,
				col_index: 1,
			}),
		);
	});

	it("searches all cells when row and column hints are stale", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: ["| Length | 42 |"],
						source_type: "table",
						page: 2,
						table_index: 1,
						row_index: 50,
						col_index: 50,
					},
				},
			},
			document,
		);
		const evidence = (
			normalized._evidence as Record<string, Record<string, unknown>>
		).length;

		expect(evidence).toEqual(
			expect.objectContaining({ table_index: 1, row_index: 1, col_index: 1 }),
		);
	});

	it("honors valid document-scoped table and page hints by default", () => {
		const documentWithTwoTables: CanonicalEvidenceDocument = {
			...document,
			tables: [
				...document.tables,
				{
					table_id: "table-2",
					page_number: 3,
					cells: [
						{ row: 1, col: 0, text: "Length", role: "row_header" },
						{ row: 1, col: 1, text: "42", role: "data" },
					],
				},
			],
		};

		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: ["| Length | 42 |"],
						source_type: "table",
						page: 3,
						table_index: 2,
						row_index: 1,
						col_index: 1,
					},
				},
			},
			documentWithTwoTables,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).length,
		).toEqual(
			expect.objectContaining({
				page: 3,
				table_index: 2,
				row_index: 1,
				col_index: 1,
			}),
		);
	});

	it("does not activate table matching from a page hint alone", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				length: 42,
				_evidence: {
					length: {
						snippets: [],
						source_type: "",
						page: 2,
						table_index: null,
						row_index: null,
						col_index: null,
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).length,
		).toEqual(
			expect.objectContaining({
				source_type: "",
				page: null,
				table_index: null,
				row_index: null,
				col_index: null,
			}),
		);
	});

	it("leaves unresolved Evidence schema-shaped without inventing a location", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				note: "missing",
				_evidence: {
					note: {
						snippets: ["not in canonical document"],
						source_type: "",
						page: null,
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).note,
		).toEqual(expect.objectContaining({ source_type: "", page: null }));
	});

	it("clears a stale page when text Evidence cannot be resolved", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				note: "missing",
				_evidence: {
					note: {
						snippets: ["not in canonical document"],
						inferred: false,
						source_type: "text",
						page: 99,
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).note,
		).toEqual(
			expect.objectContaining({
				snippets: ["not in canonical document"],
				inferred: false,
				source_type: "text",
				page: null,
			}),
		);
	});

	it("clears stale locations when table Evidence cannot be resolved", () => {
		const normalized = normalizeEmbeddedEvidence(
			{
				note: "missing",
				_evidence: {
					note: {
						snippets: ["not in canonical document"],
						inferred: true,
						source_type: "table",
						page: 99,
						table_index: 99,
						row_index: 50,
						col_index: 50,
						row_header_text: "stale row",
						column_header_text: "stale column",
					},
				},
			},
			document,
		);

		expect(
			(normalized._evidence as Record<string, Record<string, unknown>>).note,
		).toEqual(
			expect.objectContaining({
				snippets: ["not in canonical document"],
				inferred: true,
				source_type: "table",
				page: null,
				table_index: null,
				row_index: null,
				col_index: null,
				row_header_text: "",
				column_header_text: "",
			}),
		);
	});
});
