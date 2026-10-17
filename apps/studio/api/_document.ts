import type { SourcePageSpan } from "db";
import { ApiError, type FormValue } from "./_http.js";

export type DocumentInput = {
	readonly file: File | null;
	readonly pages: number | null;
	// Pre-parsed Markdown from the parsing service (the document's "index"). When
	// present it replaces page-image rendering as the model's view of the document.
	readonly markdown: string | null;
	// Each page's span in `markdown`, for excerpting it by physical page.
	readonly pageSpans?: readonly SourcePageSpan[];
};

export function parseInstruction(value: FormValue | null): string {
	if (value === null || value === "") return "";
	if (typeof value !== "string") {
		throw new ApiError(400, "invalid_request", "instruction must be text");
	}
	return value.trim();
}
