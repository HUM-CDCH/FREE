import { describe, expect, it, vi } from "vitest";
import { extractArticle } from "./_article.js";
import type { ExtractionSchemaEnvelope } from "./_catalog.js";
import { fixture, parseJson } from "./_fixtures.js";

describe("extractArticle", () => {
	it("uses one whole-document call and conforms collagen without inferring Catalog from entries", async () => {
		const schema = fixture<ExtractionSchemaEnvelope>(
			"../../schemas/JournalArticles/collagen_extraction.json",
		);
		const generated = fixture<Record<string, unknown>>("article-result.json");
		const generate = vi.fn().mockResolvedValue(generated);
		const sourceDocument = "# Collagen study";

		const extraction = await extractArticle({
			document: sourceDocument,
			tables: [
				{
					page_number: 2,
					cells: [{ row: 0, col: 1, role: "data", text: "42" }],
				},
			],
			schema,
			generate,
		});

		expect(generate).toHaveBeenCalledOnce();
		const modelInput = generate.mock.calls[0]?.[0];
		expect(modelInput?.document).toContain(sourceDocument);
		const inventoryStart = modelInput?.document.indexOf(
			"[",
			sourceDocument.length,
		);
		expect(inventoryStart).toBeGreaterThan(-1);
		const inventory = parseJson<unknown>(
			modelInput?.document.slice(inventoryStart) ?? "null",
			"Article canonical table inventory",
		);
		expect(inventory).toEqual([
			{
				table_index: 1,
				page: 2,
				cells: [{ row: 0, col: 1, role: "data", text: "42" }],
			},
		]);
		expect(modelInput?.schema).toEqual(schema.record);
		expect(modelInput?.instructions).toContain(
			JSON.stringify(schema._schema_metadata),
		);
		expect(extraction.warnings).toEqual([]);
		expect(extraction.result.paper_title).toBe("Collagen study");
		expect(
			(extraction.result.entries as Array<Record<string, unknown>>)[0],
		).toEqual(
			expect.objectContaining({
				scientific_name: "Gadus morhua",
				tissue: "Skin",
			}),
		);
	});
});
