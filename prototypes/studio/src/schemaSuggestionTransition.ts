import {
	applySchemaSuggestion,
	validateExtractionSchema,
	type ExtractionSchemaEnvelope,
	type SchemaFreshness,
	type SchemaSuggestion,
} from "../shared/schema";
import type { TemplateState } from "./SchemaPanel";

export type SchemaSuggestionReviewState = {
	readonly template: Extract<TemplateState, { status: "ready" | "idle" }>;
	readonly revision: number;
	readonly suggestion: SchemaSuggestion | null;
	readonly suggestionInputsKey: string;
};

export type SchemaSuggestionReviewResult =
	| { readonly status: "applied"; readonly state: SchemaSuggestionReviewState }
	| { readonly status: "stale" | "invalid" };

export function applyPendingSchemaSuggestionTransition(
	state: SchemaSuggestionReviewState,
	freshness: SchemaFreshness,
): SchemaSuggestionReviewResult {
	if (!state.suggestion) return { status: "invalid" };
	if (
		freshness.documentEpoch !== state.suggestion.documentEpoch ||
		freshness.revision !== state.suggestion.baseRevision
	) {
		return { status: "stale" };
	}
	const rootSet =
		state.suggestion.changes.length === 1
			? state.suggestion.changes[0]
			: undefined;
	const result =
		state.template.status === "ready"
			? applySchemaSuggestion(
					state.template.schema,
					freshness,
					state.suggestion,
				)
			: rootSet?.operation === "set" &&
					rootSet.path.length === 0 &&
					validateExtractionSchema(rootSet.value).valid
				? {
						status: "applied" as const,
						schema: rootSet.value as unknown as ExtractionSchemaEnvelope,
					}
				: { status: "invalid" as const };
	if (result.status !== "applied") return { status: result.status };
	return {
		status: "applied",
		state: {
			template: {
				status: "ready",
				schema: result.schema,
				inputsKey: state.suggestionInputsKey,
				source: "generated",
				edited: true,
			},
			revision: state.revision + 1,
			suggestion: null,
			suggestionInputsKey: "",
		},
	};
}

export function rejectSchemaSuggestionTransition(
	state: SchemaSuggestionReviewState,
): SchemaSuggestionReviewState {
	return { ...state, suggestion: null, suggestionInputsKey: "" };
}
