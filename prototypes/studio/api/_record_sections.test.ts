import { describe, expect, it } from "vitest";
import {
	partitionRepeatedMarkdownRecords,
	repeatedRecordsMixTableSchemas,
} from "./_record_sections.ts";

describe("partitionRepeatedMarkdownRecords", () => {
	it("uses the dominant repeated heading shape and keeps nested headings inside each record", () => {
		const markdown = [
			"# Grav 8",
			"Ark: 67",
			"# Fundliste grav 8",
			"| 8-2 | Jern |",
			"# Grav 13",
			"Ark: 24",
			"# Skelet",
			"| 13-1 | Del af lårben |",
			"# Grav 24",
			"Ark: 1, 5, 6, 7, 14",
			"# Fundliste grav 24",
			"| 24-1 | Lerkar |",
		].join("\n");

		expect(partitionRepeatedMarkdownRecords(markdown)).toEqual([
			"# Grav 8\nArk: 67\n# Fundliste grav 8\n| 8-2 | Jern |",
			"# Grav 13\nArk: 24\n# Skelet\n| 13-1 | Del af lårben |",
			"# Grav 24\nArk: 1, 5, 6, 7, 14\n# Fundliste grav 24\n| 24-1 | Lerkar |",
		]);
	});

	it("does not partition a document without a repeated record structure", () => {
		expect(
			partitionRepeatedMarkdownRecords("# Report\nOne continuous document."),
		).toBeNull();
	});

	it("includes shared preamble context in every partition", () => {
		const markdown = [
			"# Excavation report",
			"Legend: Ark means sheet number.",
			"",
			"## Grav 8",
			"Ark: 67",
			"## Grav 13",
			"Ark: 24",
		].join("\n");

		expect(partitionRepeatedMarkdownRecords(markdown)).toEqual([
			"# Excavation report\nLegend: Ark means sheet number.\n\n## Grav 8\nArk: 67",
			"# Excavation report\nLegend: Ark means sheet number.\n\n## Grav 13\nArk: 24",
		]);
	});
});

describe("repeatedRecordsMixTableSchemas", () => {
	it("detects an extracted child array that mixes distinct table schemas", () => {
		const section = [
			"| Nummer | Beskrivelse |",
			"| --- | --- |",
			"| 28-1 | Knogle |",
			"",
			"| Fundnummer | Beskrivelse |",
			"| --- | --- |",
			"| 28-2 | Keramik |",
		].join("\n");
		const records = [{ fundliste: [{ Fund_no: "28-1" }, { Fund_no: "28-2" }] }];

		expect(repeatedRecordsMixTableSchemas(section, records)).toBe(true);
	});

	it("accepts a continued table with the same header schema", () => {
		const section = [
			"| Fundnummer | Beskrivelse |",
			"| --- | --- |",
			"| 26-1 | Keramik |",
			"",
			"| Fundnummer | Beskrivelse |",
			"| --- | --- |",
			"| 26-11 | Keramik |",
		].join("\n");
		const records = [
			{ fundliste: [{ Fund_no: "26-1" }, { Fund_no: "26-11" }] },
		];

		expect(repeatedRecordsMixTableSchemas(section, records)).toBe(false);
	});
});
