import {
	applySchemaSuggestion,
	type SchemaFreshness,
	type SchemaSuggestion,
} from "../shared/schema";
import type { TemplateState } from "./SchemaPanel";

export type SchemaSuggestionReviewState = {
	readonly template: Extract<TemplateState, { status: "ready" }>;
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
	const result = applySchemaSuggestion(
		state.template.schema,
		freshness,
		state.suggestion,
	);
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
