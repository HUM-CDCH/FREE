import { describe, expect, it } from "vitest";
import burialFindsSchema from "../schemas/FieldReports/Burial_Finds.json";
import collagenExtractionSchema from "../schemas/JournalArticles/collagen_extraction.json";
import {
	burialFindsPinnedSchema,
	collagenExtractionPinnedSchema,
	pinnedSchemas,
} from "./pinnedSchemas";

describe("pinnedSchemas", () => {
	it("catalogues each full schema envelope with its explicit extraction strategy", () => {
		expect(
			pinnedSchemas.map(({ id, strategy }) => ({ id, strategy })),
		).toEqual([
			{ id: "FieldReports/Burial_Finds", strategy: "catalog" },
			{
				id: "JournalArticles/collagen_extraction",
				strategy: "article",
			},
		]);
	});

	it("uses the verbatim production envelopes rather than rebuilding their records", () => {
		expect(burialFindsPinnedSchema.schema).toBe(burialFindsSchema);
		expect(collagenExtractionPinnedSchema.schema).toBe(
			collagenExtractionSchema,
		);
		expect(burialFindsPinnedSchema.schema._schema_metadata).toHaveProperty(
			"record.entries",
		);
		expect(collagenExtractionPinnedSchema.schema.record).toHaveProperty(
			"entries.0._evidence",
		);
	});
});
