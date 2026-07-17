import type { SchemaFreshness } from "../shared/schema";
import type { SchemaGenerationState, TemplateState } from "./SchemaPanel";

export type NewDocumentContext = {
	readonly freshness: SchemaFreshness;
	readonly template: TemplateState;
	readonly schemaGeneration: SchemaGenerationState;
	readonly schemaSuggestion: null;
	readonly schemaSuggestionInputsKey: "";
	readonly annotationItems: readonly [];
};

export function createNewDocumentContext(
	currentDocumentEpoch: number,
): NewDocumentContext {
	return {
		freshness: { documentEpoch: currentDocumentEpoch + 1, revision: 0 },
		template: { status: "idle" },
		schemaGeneration: { status: "idle" },
		schemaSuggestion: null,
		schemaSuggestionInputsKey: "",
		annotationItems: [],
	};
}

export function isCurrentDocumentWork(
	invocation: SchemaFreshness,
	current: SchemaFreshness,
	aborted: boolean,
): boolean {
	return (
		!aborted &&
		invocation.documentEpoch === current.documentEpoch &&
		invocation.revision === current.revision
	);
}
