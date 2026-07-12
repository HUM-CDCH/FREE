import { describe, expect, it } from "vitest";
import { evaluateBurialFindExtraction } from "./burialFindEvaluation.ts";

const oracle = {
	source: {
		filename: "fixture.pdf",
		content_sha256: "a".repeat(64),
		page_count: 1,
	},
	entries: [
		{
			Grav_id: "8",
			Ark_no: "67",
			fundliste: [
				{
					Fund_no: "8-2",
					Fund_beskrivelse: "Jern",
					Fundplacering: "ved det ene lårben",
					Fund_bemaerkning: "jernspænde",
				},
			],
		},
	],
};

const result = {
	entries: [
		{
			Grav_id: "8",
			Ark_no: "67",
			fundliste: [
				{
					Fund_no: "8-2",
					Fund_beskrivelse: "Jern",
					Fundplacering: "ved det ene lårben",
					Fund_bemaerkning: "jernspænde",
				},
			],
		},
	],
};

const evidence = {
	entries: [
		{
			Grav_id: { value: "8", snippet: "Grav 8", page: null },
			Ark_no: { value: "67", snippet: "Ark: 67", page: null },
			fundliste: [
				{
					Fund_no: {
						value: "8-2",
						snippet: "| 8-2 | Jern | jernspænde |",
						page: null,
					},
					Fund_beskrivelse: {
						value: "Jern",
						snippet: "| 8-2 | Jern | jernspænde |",
						page: null,
					},
					Fundplacering: {
						value: "ved det ene lårben",
						snippet: "ved det ene lårben",
						page: null,
					},
					Fund_bemaerkning: {
						value: "jernspænde",
						snippet: "| 8-2 | Jern | jernspænde |",
						page: null,
					},
				},
			],
		},
	],
};

describe("evaluateBurialFindExtraction", () => {
	it("accepts an exact, source-grounded extraction result", () => {
		const report = evaluateBurialFindExtraction({
			result,
			evidence,
			oracle,
			canonicalMarkdown: [
				"# Grav 8",
				"Ark: 67",
				"ved det ene lårben",
				"| 8-2 | Jern | jernspænde |",
			].join("\n"),
		});

		expect(report.pass).toBe(true);
		expect(report.issues).toEqual([]);
		expect(report.metrics).toEqual({
			graves: { expected: 1, actual: 1, matched: 1 },
			finds: { expected: 1, actual: 1, matched: 1 },
			exactFields: { expected: 5, matched: 5 },
			evidence: { required: 6, grounded: 6 },
		});
	});

	it("rejects skeletal-table rows misclassified as explicit fund-list items", () => {
		const contaminated = structuredClone(result);
		contaminated.entries[0].fundliste.push({
			Fund_no: "8-1",
			Fund_beskrivelse: "Kæbe og tænder",
			Fundplacering: "",
			Fund_bemaerkning: "",
		});

		const report = evaluateBurialFindExtraction({
			result: contaminated,
			evidence,
			oracle,
			canonicalMarkdown: "# Grav 8\nArk: 67\n| 8-2 | Jern | jernspænde |",
		});

		expect(report.pass).toBe(false);
		expect(report.issues).toContain("Unexpected find 8/8-1.");
		expect(report.metrics.finds).toEqual({
			expected: 1,
			actual: 2,
			matched: 1,
		});
	});
});
