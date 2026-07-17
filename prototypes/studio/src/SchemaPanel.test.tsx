import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SchemaPanel from "./SchemaPanel";
import { burialFindsPinnedSchema, pinnedSchemas } from "./pinnedSchemas";

describe("SchemaPanel pinned schemas", () => {
	it("exposes Burial Finds as an editable pinned Extraction Schema", () => {
		const html = renderToStaticMarkup(
			createElement(SchemaPanel, {
				state: {
					status: "ready",
					schema: burialFindsPinnedSchema.schema,
					inputsKey: "",
					source: "pinned",
					pinnedSchemaId: "FieldReports/Burial_Finds",
				},
				stale: false,
				pinnedSchemas,
				selectedPinnedSchemaId: "FieldReports/Burial_Finds",
				onSelectPinnedSchema: () => undefined,
				onGenerate: () => undefined,
				onSchemaChange: () => undefined,
				annotationCount: 0,
				annotationsMode: "hints",
				onAnnotationsModeChange: () => undefined,
			}),
		);

		expect(html).toContain("FieldReports / Burial_Finds");
		expect(html).toContain("JournalArticles / collagen_extraction");
		expect(html).toContain("pinned from FREE-technical");
		expect(html).toContain("Edit field: entries");
		expect(html).toContain("+ Add field");
	});

	it("keeps the approved schema visible while generation is pending", () => {
		const html = renderToStaticMarkup(
			createElement(SchemaPanel, {
				state: {
					status: "ready",
					schema: burialFindsPinnedSchema.schema,
					inputsKey: "",
					source: "pinned",
					pinnedSchemaId: "FieldReports/Burial_Finds",
				},
				generationState: { status: "generating" },
				suggestion: null,
				stale: false,
				pinnedSchemas,
				selectedPinnedSchemaId: "FieldReports/Burial_Finds",
				onSelectPinnedSchema: vi.fn(),
				onGenerate: vi.fn(),
				onSchemaChange: vi.fn(),
				onApplySuggestion: vi.fn(),
				onRejectSuggestion: vi.fn(),
				annotationCount: 0,
				annotationsMode: "hints",
				onAnnotationsModeChange: vi.fn(),
			}),
		);

		expect(html).toContain("Producing schema from the document");
		expect(html).toContain("Edit field: entries");
	});

	it("previews a generated root replacement with review actions", () => {
		const generated = {
			name: "Generated review",
			record: { title: "verbatim-string" },
		};
		const html = renderToStaticMarkup(
			createElement(SchemaPanel, {
				state: {
					status: "ready",
					schema: burialFindsPinnedSchema.schema,
					inputsKey: "",
					source: "pinned",
					pinnedSchemaId: "FieldReports/Burial_Finds",
				},
				generationState: { status: "idle" },
				suggestion: {
					id: "generated-1",
					documentEpoch: 2,
					baseRevision: 4,
					summary: "Generated from the Source Document",
					changes: [{ operation: "set", path: [], value: generated }],
				},
				suggestionStale: false,
				stale: false,
				pinnedSchemas,
				selectedPinnedSchemaId: "FieldReports/Burial_Finds",
				onSelectPinnedSchema: vi.fn(),
				onGenerate: vi.fn(),
				onSchemaChange: vi.fn(),
				onApplySuggestion: vi.fn(),
				onRejectSuggestion: vi.fn(),
				annotationCount: 0,
				annotationsMode: "hints",
				onAnnotationsModeChange: vi.fn(),
			}),
		);

		expect(html).toContain("Schema Suggestion");
		expect(html).toContain("Generated review");
		expect(html).toContain("Apply");
		expect(html).toContain("Reject");
		expect(html).toContain("Edit field: entries");
	});

	it("renders stale suggestions as visibly refused", () => {
		const html = renderToStaticMarkup(
			createElement(SchemaPanel, {
				state: {
					status: "ready",
					schema: burialFindsPinnedSchema.schema,
					inputsKey: "",
					source: "pinned",
				},
				generationState: { status: "idle" },
				suggestion: {
					id: "stale-1",
					documentEpoch: 1,
					baseRevision: 1,
					summary: "Generated from the Source Document",
					changes: [
						{
							operation: "set",
							path: [],
							value: burialFindsPinnedSchema.schema,
						},
					],
				},
				suggestionStale: true,
				stale: false,
				pinnedSchemas,
				selectedPinnedSchemaId: null,
				onSelectPinnedSchema: vi.fn(),
				onGenerate: vi.fn(),
				onSchemaChange: vi.fn(),
				onApplySuggestion: vi.fn(),
				onRejectSuggestion: vi.fn(),
				annotationCount: 0,
				annotationsMode: "hints",
				onAnnotationsModeChange: vi.fn(),
			}),
		);

		expect(html).toContain("This suggestion is stale");
		expect(html).toContain("disabled");
	});
});
