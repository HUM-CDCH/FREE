import { describe, expect, it } from "vitest";
import type { SchemaSuggestion } from "../shared/schema";
import { burialFindsPinnedSchema } from "./pinnedSchemas";
import { projectExtractionState } from "./useExtraction";
import {
	applyPendingSchemaSuggestionTransition,
	rejectSchemaSuggestionTransition,
	type SchemaSuggestionReviewState,
} from "./schemaSuggestionTransition";

const generatedSchema = {
	name: "Generated",
	description: "",
	record: { title: "verbatim-string" },
	_schema_metadata: {},
};
const suggestion: SchemaSuggestion = {
	id: "server-suggestion-1",
	documentEpoch: 2,
	baseRevision: 4,
	summary: "Generated from the Source Document",
	changes: [{ operation: "set", path: [], value: generatedSchema }],
};
const reviewState: SchemaSuggestionReviewState = {
	template: {
		status: "ready",
		schema: burialFindsPinnedSchema.schema,
		inputsKey: "old-inputs",
		source: "pinned",
	},
	revision: 4,
	suggestion,
	suggestionInputsKey: "generated-inputs",
};

describe("schema suggestion review transitions", () => {
	it("applies atomically and invalidates Extraction Results through revision identity", () => {
		const result = applyPendingSchemaSuggestionTransition(reviewState, {
			documentEpoch: 2,
			revision: 4,
		});
		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(result.state).toMatchObject({
			template: {
				schema: generatedSchema,
				inputsKey: "generated-inputs",
				source: "generated",
				edited: true,
			},
			revision: 5,
			suggestion: null,
			suggestionInputsKey: "",
		});

		expect(result.state.template.status).toBe("ready");
		if (result.state.template.status !== "ready") return;
		const appliedSchema = result.state.template.schema;

		const previousResult = {
			documentEpoch: 2,
			schemaRevision: 4,
			taskId: "task-1",
			schema: burialFindsPinnedSchema.schema,
			strategy: "catalog" as const,
			state: { status: "ready" as const, result: {}, warnings: [] },
		};
		expect(
			projectExtractionState(previousResult, {
				...previousResult,
				schemaRevision: result.state.revision,
				schema: appliedSchema,
			}),
		).toEqual({ status: "idle" });
	});

	it("applies a root schema when no approved schema exists", () => {
		const result = applyPendingSchemaSuggestionTransition(
			{
				template: { status: "idle" },
				revision: 4,
				suggestion,
				suggestionInputsKey: "chat-inputs",
			},
			{ documentEpoch: 2, revision: 4 },
		);

		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(result.state.template).toMatchObject({
			status: "ready",
			schema: generatedSchema,
			inputsKey: "chat-inputs",
			source: "generated",
		});
		expect(result.state.revision).toBe(5);
	});

	it("applies nested chat changes to an editable copy of a pinned schema", () => {
		const pinnedSchema = {
			name: "Finds",
			record: {
				material: "verbatim-string",
				obsolete: "verbatim-string",
				_evidence: {
					material: {
						snippets: [],
						inferred: false,
						source_type: "",
						page: null,
						table_index: null,
						row_index: null,
						col_index: null,
						row_header_text: "",
						column_header_text: "",
					},
				},
			},
			_schema_metadata: { "record.material": { mode: "verbatim" } },
		};
		const nestedSuggestion: SchemaSuggestion = {
			id: "server-suggestion-9",
			documentEpoch: 2,
			baseRevision: 4,
			summary: "Update finds",
			changes: [
				{ operation: "rename", path: ["material"], name: "substance" },
				{ operation: "remove", path: ["obsolete"] },
				{ operation: "set", path: ["period"], value: "verbatim-string" },
			],
		};
		const result = applyPendingSchemaSuggestionTransition(
			{
				...reviewState,
				template: {
					status: "ready",
					schema: pinnedSchema,
					inputsKey: "pinned",
					source: "pinned",
				},
				suggestion: nestedSuggestion,
			},
			{ documentEpoch: 2, revision: 4 },
		);

		expect(result.status).toBe("applied");
		if (result.status !== "applied" || result.state.template.status !== "ready")
			return;
		expect(result.state.template).toMatchObject({
			source: "generated",
			edited: true,
		});
		expect(result.state.template.schema.record).toHaveProperty("substance");
		expect(result.state.template.schema.record).not.toHaveProperty("material");
		expect(result.state.template.schema.record).not.toHaveProperty("obsolete");
		expect(result.state.template.schema.record).toHaveProperty("period");
		expect(result.state.template.schema._schema_metadata).toEqual({
			"record.substance": { mode: "verbatim" },
		});
		expect(pinnedSchema.record).toHaveProperty("material");
		expect(result.state.revision).toBe(5);
	});

	it("rejects an invalid complete chat change set without replacement state", () => {
		const result = applyPendingSchemaSuggestionTransition(
			{
				...reviewState,
				suggestion: {
					...suggestion,
					changes: [{ operation: "remove", path: ["missing"] }],
				},
			},
			{ documentEpoch: 2, revision: 4 },
		);
		expect(result).toEqual({ status: "invalid" });
	});

	it("rejects without changing the approved schema or revision", () => {
		const rejected = rejectSchemaSuggestionTransition(reviewState);
		expect(rejected.template).toBe(reviewState.template);
		expect(rejected.revision).toBe(4);
		expect(rejected.suggestion).toBeNull();
		expect(rejected.suggestionInputsKey).toBe("");
	});

	it("refuses stale apply without producing replacement state", () => {
		expect(
			applyPendingSchemaSuggestionTransition(reviewState, {
				documentEpoch: 2,
				revision: 5,
			}),
		).toEqual({ status: "stale" });
	});
});
