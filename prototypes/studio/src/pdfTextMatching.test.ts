import { describe, expect, it } from "vitest";
import { matchPdfTextItems, normalizePdfText } from "./pdfTextMatching.ts";

describe("matchPdfTextItems", () => {
	it("matches complete numeric tokens instead of numeric substrings", () => {
		expect(matchPdfTextItems(["17", "7"], "7")).toEqual([1]);
	});

	it("rejects larger hyphenated tokens", () => {
		expect(matchPdfTextItems(["28-29", "8-20"], "8-2")).toEqual([]);
	});

	it("assembles a query from adjacent PDF items", () => {
		expect(matchPdfTextItems(["Gadus", "morhua"], "Gadus morhua")).toEqual([
			0, 1,
		]);
	});

	it("normalizes subscripts, superscripts, dashes, diacritics, punctuation, and whitespace", () => {
		expect(normalizePdfText(" T₀  8–2; Café ³ ")).toBe("t0 8-2 cafe 3");
		expect(matchPdfTextItems(["T₀"], "To")).toEqual([0]);
	});

	it("maps multiple normalized tokens from one PDF item back once", () => {
		expect(matchPdfTextItems(["Gadus, morhua"], "Gadus morhua")).toEqual([0]);
	});

	it("uses Python SequenceMatcher parity for fuzzy alphabetic tokens", () => {
		expect(matchPdfTextItems(["collagens"], "collagen")).toEqual([0]);
		expect(matchPdfTextItems(["abaa"], "aaaa")).toEqual([]);
		expect(matchPdfTextItems(["abxd"], "abcd")).toEqual([0]);
	});

	it("keeps alphabetic tolerance without relaxing digit boundaries", () => {
		expect(matchPdfTextItems(["17"], "7")).toEqual([]);
	});
});
