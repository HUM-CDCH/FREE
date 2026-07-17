import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SchemaSuggestion } from "../shared/schema";
import { SchemaSuggestionCard } from "./SchemaSuggestionCard";

const suggestion: SchemaSuggestion = {
	id: "server-owned-8",
	documentEpoch: 2,
	baseRevision: 3,
	summary: "Extract finds",
	changes: [
		{
			operation: "set",
			path: [],
			value: {
				name: "Finds",
				record: { material: "verbatim-string" },
				_schema_metadata: {},
			},
		},
	],
};

function render(value: Parameters<typeof SchemaSuggestionCard>[0]["value"]) {
	return renderToStaticMarkup(
		createElement(SchemaSuggestionCard, {
			value,
			onApply: vi.fn(),
			onReject: vi.fn(),
		}),
	);
}

describe("SchemaSuggestionCard", () => {
	it("previews validated output with Apply and Reject actions", () => {
		const html = render({ state: "output-available", suggestion });
		expect(html).toContain("Extract finds");
		expect(html).toContain("material");
		expect(html).toContain("Apply");
		expect(html).toContain("Reject");
	});

	it("renders input and invalid-output states without review actions", () => {
		expect(
			render({ state: "input-available", summary: "Extract finds" }),
		).toContain("Validating");
		const error = render({
			state: "output-error",
			errorText: "The proposed Extraction Schema is invalid.",
		});
		expect(error).toContain("Schema Suggestion error");
		expect(error).not.toContain(">Apply<");
	});
});
