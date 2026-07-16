import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { extractArticle } from "./_article.js";
import type { ExtractionSchemaEnvelope } from "./_catalog.js";

function fixture<T>(name: string): T {
	const text = readFileSync(
		new URL(`./test-fixtures/${name}`, import.meta.url),
		"utf8",
	);
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Invalid JSON test fixture: ${name}`, { cause: error });
	}
}

describe("extractArticle", () => {
	it("uses one whole-document call and conforms collagen without inferring Catalog from entries", async () => {
		const schema = fixture<ExtractionSchemaEnvelope>(
			"../../schemas/JournalArticles/collagen_extraction.json",
		);
		const generated = fixture<Record<string, unknown>>("article-result.json");
		const generate = vi.fn().mockResolvedValue(generated);

		const extraction = await extractArticle({
			document: "# Collagen study",
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
		expect(modelInput?.document).toContain("# Collagen study");
		expect(modelInput?.document).toContain("CANONICAL TABLE INVENTORY");
		expect(modelInput?.document).toContain('"table_index": 1');
		expect(modelInput?.document).toContain('"page": 2');
		expect(modelInput?.document).toContain('"row": 0');
		expect(modelInput?.document).toContain('"col": 1');
		expect(modelInput?.document).toContain('"role": "data"');
		expect(modelInput?.document).toContain('"text": "42"');
		expect(modelInput?.instructions).toContain("document-global and 1-based");
		expect(modelInput?.instructions).toContain(
			"row and col coordinates are 0-based",
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
