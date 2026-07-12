import { describe, expect, it } from "vitest";
import { groundExtractionResult } from "./_evidence_grounding.ts";

describe("groundExtractionResult", () => {
	it("keeps extracted values clean and attaches verbatim source evidence", () => {
		const extracted = {
			entries: [
				{
					Grav_id: "8",
					Ark_no: "67",
					fundliste: [
						{
							Fund_no: "8-2",
							Fund_beskrivelse: "Jern",
							Fundplacering: "",
							Fund_bemaerkning: "jernspænde",
						},
					],
				},
			],
		};
		const source = "# Grav 8\n\nArk: 67\n\n| 8-2 | Jern | jernspænde |";

		expect(groundExtractionResult(extracted, source)).toEqual({
			result: extracted,
			evidence: {
				entries: [
					{
						Grav_id: { value: "8", snippet: "# Grav 8", page: null },
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
								Fund_bemaerkning: {
									value: "jernspænde",
									snippet: "| 8-2 | Jern | jernspænde |",
									page: null,
								},
							},
						],
					},
				],
			},
		});
	});

	it("uses sibling values to disambiguate repeated evidence text", () => {
		const extracted = {
			find: {
				Fund_no: "30-7",
				Fund_beskrivelse: "Keramikskår",
				Fund_bemaerkning: "Fundet ved afrensning",
			},
		};
		const source = [
			"| 30-6 | Knoglefragmenter | Fundet ved afrensning |",
			"| 30-7 | Keramikskår | Fundet ved afrensning |",
		].join("\n");

		const grounded = groundExtractionResult(extracted, source);

		expect(grounded.evidence).toMatchObject({
			find: {
				Fund_bemaerkning: {
					snippet: "| 30-7 | Keramikskår | Fundet ved afrensning |",
				},
			},
		});
	});

	it("removes an extracted value that cannot be grounded in the source", () => {
		expect(groundExtractionResult({ name: "invented" }, "source text")).toEqual(
			{
				result: { name: null },
				evidence: null,
			},
		);
	});
});
