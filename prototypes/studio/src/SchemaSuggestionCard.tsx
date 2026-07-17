import type { SchemaSuggestion } from "../shared/schema";
import { Button, Overline } from "./ui";

export type SchemaSuggestionCardState =
	| { readonly state: "input-streaming" }
	| { readonly state: "input-available"; readonly summary: string }
	| { readonly state: "output-error"; readonly errorText: string }
	| {
			readonly state: "output-available";
			readonly suggestion: SchemaSuggestion;
	  };

type SchemaSuggestionCardProps = {
	readonly value: SchemaSuggestionCardState;
	readonly stale?: boolean;
	readonly onApply: (suggestion: SchemaSuggestion) => void;
	readonly onReject: (suggestion: SchemaSuggestion) => void;
};

function suggestionPreview(suggestion: SchemaSuggestion): string {
	const rootSet = suggestion.changes.find(
		(change) => change.operation === "set" && change.path.length === 0,
	);
	if (rootSet?.operation === "set") {
		return JSON.stringify(rootSet.value, null, 2);
	}
	return suggestion.changes
		.map((change) => {
			const path = change.path.join(" → ");
			if (change.operation === "rename")
				return `Rename ${path} to ${change.name}`;
			if (change.operation === "remove") return `Remove ${path}`;
			return `Set ${path}\n${JSON.stringify(change.value, null, 2)}`;
		})
		.join("\n\n");
}

export function SchemaSuggestionCard({
	value,
	stale = false,
	onApply,
	onReject,
}: SchemaSuggestionCardProps) {
	if (value.state === "input-streaming") {
		return (
			<section
				className="rounded-xl border border-line p-3"
				aria-label="Schema Suggestion"
			>
				<p className="text-xs text-ink-muted">Receiving Schema Suggestion…</p>
			</section>
		);
	}
	if (value.state === "input-available") {
		return (
			<section
				className="rounded-xl border border-line p-3"
				aria-label="Schema Suggestion"
			>
				<p className="text-xs text-ink-muted">Validating {value.summary}…</p>
			</section>
		);
	}
	if (value.state === "output-error") {
		return (
			<section
				className="rounded-xl border border-danger/40 p-3"
				aria-label="Schema Suggestion error"
			>
				<Overline as="h3">Schema Suggestion error</Overline>
				<p className="mt-1 text-xs text-danger">{value.errorText}</p>
			</section>
		);
	}

	const { suggestion } = value;
	return (
		<section
			className="rounded-xl border border-accent/40 bg-accent-ghost p-3"
			aria-label="Schema Suggestion"
		>
			<Overline as="h3">Schema Suggestion</Overline>
			<p className="mt-1 text-xs text-ink-muted">{suggestion.summary}</p>
			<pre className="mt-2 overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2 font-mono text-[11px] text-ink">
				{suggestionPreview(suggestion)}
			</pre>
			{stale && (
				<p className="mt-2 text-xs font-semibold text-danger" role="status">
					This suggestion no longer matches the active document or approved
					schema.
				</p>
			)}
			<div className="mt-3 flex justify-end gap-2">
				<Button variant="pill" size="sm" onClick={() => onReject(suggestion)}>
					Reject
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={stale}
					onClick={() => onApply(suggestion)}
				>
					Apply
				</Button>
			</div>
		</section>
	);
}
