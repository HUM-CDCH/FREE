export type ReviewedToolCalls = Readonly<
	Record<string, "applied" | "rejected">
>;

export function recordSuggestionReview(
	current: ReviewedToolCalls,
	toolCallId: string,
	decision: "applied" | "rejected",
): ReviewedToolCalls {
	return current[toolCallId] ? current : { ...current, [toolCallId]: decision };
}
