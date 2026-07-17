import { describe, expect, it } from "vitest";
import { matchCanonicalTableEvidence } from "./_table_evidence.ts";

const tables = [
	{
		table_id: "table-1",
		page_number: 1,
		cells: [
			{ row: 0, col: 0, text: "ID", role: "column_header" },
			{ row: 1, col: 0, text: "other", role: "data" },
		],
	},
	{
		table_id: "table-2",
		page_number: 3,
		cells: [
			{ row: 0, col: 0, text: "ID", role: "column_header" },
			{ row: 1, col: 0, text: "target", role: "data" },
		],
	},
] as const;

describe("matchCanonicalTableEvidence", () => {
	it("discards Catalog section-local hints and returns document-global coordinates", () => {
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					snippets: ["| ID | target |"],
					source_type: "table",
					page: 1,
					table_index: 1,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "target",
				tables,
				strategy: "catalog",
			}),
		).toEqual(
			expect.objectContaining({
				page: 3,
				table_index: 2,
				row_index: 1,
				col_index: 0,
			}),
		);
	});

	it("does not let Catalog coordinates activate value-only table matching", () => {
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					snippets: [],
					source_type: "",
					table_index: 2,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "target",
				tables,
				strategy: "catalog",
			}),
		).toBeNull();
	});

	it("leaves duplicate canonical support ambiguous even when Catalog hints select one", () => {
		const duplicates = [
			tables[1],
			{ ...tables[1], table_id: "table-3", page_number: 4 },
		] as const;
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					snippets: ["| ID | target |"],
					source_type: "table",
					table_index: 1,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "target",
				tables: duplicates,
				strategy: "catalog",
			}),
		).toBeNull();
	});

	it("uses Article hints only when the hinted canonical cell is supported", () => {
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					snippets: ["| ID | target |"],
					source_type: "table",
					page: 1,
					table_index: 1,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "target",
				tables,
				strategy: "article",
			}),
		).toEqual(
			expect.objectContaining({
				page: 3,
				table_index: 2,
				row_index: 1,
				col_index: 0,
			}),
		);
	});

	it("does not let an Article hint resolve content-equivalent ambiguity", () => {
		const duplicates = [
			tables[1],
			{ ...tables[1], table_id: "table-3", page_number: 4 },
		] as const;
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					snippets: ["| ID | target |"],
					source_type: "table",
					table_index: 1,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "target",
				tables: duplicates,
				strategy: "article",
			}),
		).toBeNull();
	});

	it("uses a row-style snippet to disambiguate a repeated scalar value", () => {
		const repeatedValues = [
			{
				table_id: "measurements",
				page_number: 5,
				cells: [
					{ row: 0, col: 0, text: "Label", role: "column_header" },
					{ row: 0, col: 1, text: "Value", role: "column_header" },
					{ row: 1, col: 0, text: "First", role: "row_header" },
					{ row: 1, col: 1, text: "42", role: "data" },
					{ row: 2, col: 0, text: "Second", role: "row_header" },
					{ row: 2, col: 1, text: "42", role: "data" },
				],
			},
		] as const;
		expect(
			matchCanonicalTableEvidence({
				evidence: { snippets: ["| Second | 42 |"], source_type: "table" },
				fieldValue: 42,
				tables: repeatedValues,
				strategy: "catalog",
			}),
		).toEqual(
			expect.objectContaining({
				page: 5,
				table_index: 1,
				row_index: 2,
				col_index: 1,
			}),
		);
	});

	it("does not ground from Article coordinates without value or snippet support", () => {
		expect(
			matchCanonicalTableEvidence({
				evidence: {
					source_type: "table",
					table_index: 1,
					row_index: 1,
					col_index: 0,
				},
				fieldValue: "missing",
				tables,
				strategy: "article",
			}),
		).toBeNull();
	});
});
