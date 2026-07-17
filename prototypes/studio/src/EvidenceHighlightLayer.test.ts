import { describe, expect, it } from "vitest";
import { buildHighlights } from "./evidenceHighlights";

describe("buildHighlights", () => {
	it("uses embedded Evidence and falls back to direct searches for ungrounded leaves", () => {
		const result = {
			title: "Anchored title",
			author: "Searchable author",
			_evidence: {
				title: { snippets: ["Anchored title appears here"], page: 2 },
			},
		};

		expect(
			buildHighlights(result, { title: "yellow", author: "blue" }),
		).toEqual([
			{
				value: "Anchored title",
				snippet: "Anchored title appears here",
				hintPage: 2,
				color: "yellow",
			},
			{
				value: "Searchable author",
				snippet: null,
				hintPage: null,
				color: "blue",
			},
		]);
	});

	it("skips Evidence metadata instead of treating it as extracted values", () => {
		const result = {
			entries: [
				{
					id: "8",
					_evidence: {
						id: {
							snippets: ["Grav 8"],
							source_type: "text",
							row_header_text: "must not become a highlight",
						},
					},
				},
			],
		};

		expect(buildHighlights(result, { entries: "yellow" })).toEqual([
			{ value: "8", snippet: "Grav 8", hintPage: null, color: "yellow" },
		]);
	});

	it("applies field-level Evidence to every scalar-array element without positional pairing", () => {
		const result = {
			identifiers: ["7", "8-2"],
			_evidence: {
				identifiers: { snippets: ["row one", "row two"], page: 3 },
			},
		};

		expect(buildHighlights(result, { identifiers: "yellow" })).toEqual([
			{ value: "7", snippet: "row one", hintPage: 3, color: "yellow" },
			{ value: "7", snippet: "row two", hintPage: 3, color: "yellow" },
			{ value: "8-2", snippet: "row one", hintPage: 3, color: "yellow" },
			{ value: "8-2", snippet: "row two", hintPage: 3, color: "yellow" },
		]);
	});

	it("applies field-level Evidence to searchable elements of mixed scalar arrays", () => {
		const result = {
			identifiers: ["7", null, "8-2"],
			_evidence: {
				identifiers: { snippets: ["shared row"], page: 3 },
			},
		};

		expect(buildHighlights(result, { identifiers: "yellow" })).toEqual([
			{ value: "7", snippet: "shared row", hintPage: 3, color: "yellow" },
			{ value: "8-2", snippet: "shared row", hintPage: 3, color: "yellow" },
		]);
	});

	it("preserves page guidance when field-level Evidence has no snippets", () => {
		const result = {
			identifiers: ["7", "8-2"],
			_evidence: { identifiers: { snippets: [], page: 3 } },
		};

		expect(buildHighlights(result, { identifiers: "yellow" })).toEqual([
			{ value: "7", snippet: null, hintPage: 3, color: "yellow" },
			{ value: "8-2", snippet: null, hintPage: 3, color: "yellow" },
		]);
	});

	it("highlights numeric and boolean leaves when they have Evidence", () => {
		const result = {
			count: 7,
			verified: true,
			missing: null,
			_evidence: {
				count: { snippets: ["seven"] },
				verified: { snippets: ["verified"] },
				missing: { snippets: ["missing"] },
			},
		};

		expect(
			buildHighlights(result, {
				count: "yellow",
				verified: "blue",
				missing: "green",
			}),
		).toEqual([
			{ value: "7", snippet: "seven", hintPage: null, color: "yellow" },
			{ value: "true", snippet: "verified", hintPage: null, color: "blue" },
		]);
	});
});
