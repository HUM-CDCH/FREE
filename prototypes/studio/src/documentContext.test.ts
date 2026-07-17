import { describe, expect, it } from "vitest";
import {
	createNewDocumentContext,
	isCurrentDocumentWork,
} from "./documentContext";

describe("document opening lifecycle", () => {
	it("resets all App-owned work while advancing the document epoch", () => {
		expect(createNewDocumentContext(7)).toEqual({
			freshness: { documentEpoch: 8, revision: 0 },
			template: { status: "idle" },
			schemaGeneration: { status: "idle" },
			schemaSuggestion: null,
			schemaSuggestionInputsKey: "",
			annotationItems: [],
		});
	});
});

describe("document context completion guards", () => {
	it("rejects late work from a previous document epoch even when revision reset matches", () => {
		expect(
			isCurrentDocumentWork(
				{ documentEpoch: 3, revision: 0 },
				{ documentEpoch: 4, revision: 0 },
				false,
			),
		).toBe(false);
	});

	it("rejects late work from a previous revision in the same epoch", () => {
		expect(
			isCurrentDocumentWork(
				{ documentEpoch: 4, revision: 1 },
				{ documentEpoch: 4, revision: 2 },
				false,
			),
		).toBe(false);
	});

	it("accepts only unaborted work for the active epoch and revision", () => {
		const freshness = { documentEpoch: 4, revision: 2 };
		expect(isCurrentDocumentWork(freshness, freshness, false)).toBe(true);
		expect(isCurrentDocumentWork(freshness, freshness, true)).toBe(false);
	});
});
