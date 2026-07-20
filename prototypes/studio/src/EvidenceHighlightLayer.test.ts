import { describe, expect, it } from "vitest";
import { buildHighlights, highlightAlpha } from "./evidenceHighlights";
import { drawEntry } from "./evidencePaint";

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
				path: ["title"],
			},
			{
				value: "Searchable author",
				snippet: null,
				hintPage: null,
				color: "blue",
				path: ["author"],
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
			{ value: "8", snippet: "Grav 8", hintPage: null, color: "yellow", path: ["entries", "0", "id"] },
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
			{ value: "7", snippet: "row one", hintPage: 3, color: "yellow", path: ["identifiers", "0"] },
			{ value: "7", snippet: "row two", hintPage: 3, color: "yellow", path: ["identifiers", "0"] },
			{ value: "8-2", snippet: "row one", hintPage: 3, color: "yellow", path: ["identifiers", "1"] },
			{ value: "8-2", snippet: "row two", hintPage: 3, color: "yellow", path: ["identifiers", "1"] },
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
			{ value: "7", snippet: "shared row", hintPage: 3, color: "yellow", path: ["identifiers", "0"] },
			{ value: "8-2", snippet: "shared row", hintPage: 3, color: "yellow", path: ["identifiers", "2"] },
		]);
	});

	it("preserves page guidance when field-level Evidence has no snippets", () => {
		const result = {
			identifiers: ["7", "8-2"],
			_evidence: { identifiers: { snippets: [], page: 3 } },
		};

		expect(buildHighlights(result, { identifiers: "yellow" })).toEqual([
			{ value: "7", snippet: null, hintPage: 3, color: "yellow", path: ["identifiers", "0"] },
			{ value: "8-2", snippet: null, hintPage: 3, color: "yellow", path: ["identifiers", "1"] },
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
			{ value: "7", snippet: "seven", hintPage: null, color: "yellow", path: ["count"] },
			{ value: "true", snippet: "verified", hintPage: null, color: "blue", path: ["verified"] },
		]);
	});
});

describe("evidence focus", () => {
	it("selects duplicate values by path, clears focus, and marks one path active", () => {
		const paths = [["records", "0", "id"], ["records", "1", "id"]];
		expect(paths.map((path) => highlightAlpha(path, paths[1]))).toEqual([0.15, 0.75]);
		expect(paths.map((path) => highlightAlpha(path, null))).toEqual([0.4, 0.4]);
		expect(paths.filter((path) => highlightAlpha(path, paths[1]) === 0.75)).toHaveLength(1);
	});

	it('paints each cached rectangle once per repaint with one active fill', () => {
		const fills: number[] = []
		const context = { globalAlpha: 0, fillStyle: '', save: () => undefined, restore: () => undefined, fillRect: () => fills.push(context.globalAlpha) }
		const entry = (path: string[]) => ({ highlight: { value: 'duplicate', snippet: null, hintPage: null, color: 'yellow', path }, rects: [{ x: 0, y: 0, width: 10, height: 4 }], pageTop: 0, pageLeft: 0 })
		for (const path of [['records', '0'], ['records', '1']]) {
			drawEntry(context, entry(path), ['records', '1'])
		}
		expect(fills).toEqual([0.15, 0.75])
	});
});
