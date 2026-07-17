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

function rootPreview(suggestion: SchemaSuggestion): unknown {
	const rootSet = suggestion.changes.find(
		(change) => change.operation === "set" && change.path.length === 0,
	);
	return rootSet?.operation === "set" ? rootSet.value : null;
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
				{JSON.stringify(rootPreview(suggestion), null, 2)}
			</pre>
			{stale && (
				<p className="mt-2 text-xs font-semibold text-danger" role="status">
					This suggestion is stale because the approved schema changed.
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
