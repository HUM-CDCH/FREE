import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useState } from "react";
import type { AnnotationSetItem } from "./AnnotationSidebar";
import { API_BASE } from "./api";
import type { ExtractionSchemaEnvelope } from "../shared/schema";
import type { SchemaAgentUIMessage } from "../shared/schema-agent-message";

type ChatTabProps = {
	markdown: string | null;
	annotations: readonly AnnotationSetItem[];
	schema: ExtractionSchemaEnvelope | null;
	revision: number;
	documentEpoch: number;
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
}: ChatTabProps) {
	const [draft, setDraft] = useState("");
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
