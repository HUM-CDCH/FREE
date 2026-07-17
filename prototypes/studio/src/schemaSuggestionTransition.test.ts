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
				schema: result.state.template.schema,
			}),
		).toEqual({ status: "idle" });
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
