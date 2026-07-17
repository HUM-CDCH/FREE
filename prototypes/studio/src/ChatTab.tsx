import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useState } from "react";
import type { AnnotationSetItem } from "./AnnotationSidebar";
import { API_BASE } from "./api";
import {
	recordSuggestionReview,
	type ReviewedToolCalls,
} from "./chatSuggestionReview";
import type {
	ExtractionSchemaEnvelope,
	SchemaSuggestion,
} from "../shared/schema";
import type { SchemaAgentUIMessage } from "../shared/schema-agent-message";
import { SchemaSuggestionCard } from "./SchemaSuggestionCard";

type ChatTabProps = {
	markdown: string | null;
	annotations: readonly AnnotationSetItem[];
	schema: ExtractionSchemaEnvelope | null;
	revision: number;
	documentEpoch: number;
	onApplySuggestion: (suggestion: SchemaSuggestion) => boolean;
	onRejectSuggestion: (suggestion: SchemaSuggestion) => boolean;
};

const transport = new DefaultChatTransport<SchemaAgentUIMessage>({
	api: `${API_BASE}/chat`,
});

function messageText(message: SchemaAgentUIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function ChatTab({
	markdown,
	annotations,
	schema,
	revision,
	documentEpoch,
	onApplySuggestion,
	onRejectSuggestion,
}: ChatTabProps) {
	const [draft, setDraft] = useState("");
	const [reviewedToolCalls, setReviewedToolCalls] = useState<ReviewedToolCalls>(
		{},
	);
	const { messages, sendMessage, status, stop, error } =
		useChat<SchemaAgentUIMessage>({
			id: `free-document-chat-${documentEpoch}`,
			transport,
		});
	const running = status === "submitted" || status === "streaming";

	useEffect(
		() => () => {
			void stop();
		},
		[documentEpoch, stop],
	);

	function reviewSuggestion(
		toolCallId: string,
		decision: "applied" | "rejected",
		suggestion: SchemaSuggestion,
	) {
		if (reviewedToolCalls[toolCallId]) return;
		const accepted =
			decision === "applied"
				? onApplySuggestion(suggestion)
				: onRejectSuggestion(suggestion);
		if (accepted) {
			setReviewedToolCalls((current) =>
				recordSuggestionReview(current, toolCallId, decision),
			);
		}
	}

	function send() {
		const text = draft.trim();
		if (!text || running) return;
		setDraft("");
		void sendMessage(
			{ text },
			{
				body: {
					markdown,
					annotations: annotations.map(({ id, label, pageNumber }) => ({
						id,
						text: label,
						pageNumber,
					})),
					schema,
					revision,
					documentEpoch,
				},
			},
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3.5">
				{messages.length === 0 && (
					<div className="mt-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
						<p className="text-[13.5px] font-semibold text-ink">
							Ask about this source document
						</p>
						<p className="mt-1 text-xs leading-relaxed text-ink-muted">
							{markdown
								? "The current parsed Source Context is included with each question."
								: "No Source Context is available yet."}
						</p>
					</div>
				)}
				{messages.map((message) => (
					<div
						key={message.id}
						className={`animate-fadeup max-w-[90%] rounded-xl border px-3 py-2 text-xs leading-relaxed text-ink ${
							message.role === "user"
								? "self-end border-accent-soft bg-accent-ghost"
								: "self-start border-line bg-canvas"
						}`}
					>
						{messageText(message)}
						{message.parts.map((part) => {
							if (part.type !== "tool-proposeSchemaChanges") return null;
							const key = part.toolCallId;
							if (part.state === "output-available") {
								const decision = reviewedToolCalls[key];
								if (decision) {
									return (
										<p key={key} className="mt-2 font-semibold text-ink-muted">
											Schema Suggestion {decision}
										</p>
									);
								}
								return (
									<SchemaSuggestionCard
										key={key}
										value={{
											state: "output-available",
											suggestion: part.output,
										}}
										stale={
											part.output.documentEpoch !== documentEpoch ||
											part.output.baseRevision !== revision
										}
										onApply={(suggestion) =>
											reviewSuggestion(key, "applied", suggestion)
										}
										onReject={(suggestion) =>
											reviewSuggestion(key, "rejected", suggestion)
										}
									/>
								);
							}
							if (part.state === "output-error") {
								return (
									<SchemaSuggestionCard
										key={key}
										value={{ state: "output-error", errorText: part.errorText }}
										onApply={onApplySuggestion}
										onReject={onRejectSuggestion}
									/>
								);
							}
							if (part.state === "input-available") {
								return (
									<SchemaSuggestionCard
										key={key}
										value={{
											state: "input-available",
											summary: part.input.summary,
										}}
										onApply={onApplySuggestion}
										onReject={onRejectSuggestion}
									/>
								);
							}
							return (
								<SchemaSuggestionCard
									key={key}
									value={{ state: "input-streaming" }}
									onApply={onApplySuggestion}
									onReject={onRejectSuggestion}
								/>
							);
						})}
					</div>
				))}
				{error && <p className="text-xs text-red-600">{error.message}</p>}
			</div>
			<div className="flex shrink-0 gap-2 border-t border-line px-3 py-2.5">
				<input
					className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent"
					value={draft}
					placeholder="Ask about this source document..."
					disabled={running}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") send();
					}}
				/>
				<button
					className="shrink-0 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 py-2 text-[13px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60"
					type="button"
					title="Send"
					disabled={running}
					onClick={send}
				>
					↑
				</button>
			</div>
		</div>
	);
}

export default ChatTab;
