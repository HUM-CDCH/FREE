/** @vitest-environment jsdom */
import { useChat } from "@ai-sdk/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import ChatTab from "./ChatTab";

vi.mock("@ai-sdk/react", () => ({ useChat: vi.fn() }));

const oldStop = vi.fn(async () => undefined);
const currentStop = vi.fn(async () => undefined);
const sessions = new Map([
	[
		"free-document-chat-1",
		{
			messages: [
				{
					id: "old-answer",
					role: "assistant",
					parts: [{ type: "text", text: "Old partial answer" }],
				},
			],
			sendMessage: vi.fn(),
			status: "streaming",
			stop: oldStop,
			error: undefined,
		},
	],
	[
		"free-document-chat-2",
		{
			messages: [],
			sendMessage: vi.fn(),
			status: "ready",
			stop: currentStop,
			error: undefined,
		},
	],
]);

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	vi.mocked(useChat).mockImplementation((options) => {
		const id = (options as { id: string }).id;
		const session = sessions.get(id);
		if (!session) throw new Error(`Unexpected chat session: ${id}`);
		return session as unknown as ReturnType<typeof useChat>;
	});
});

const commonProps = {
	markdown: "Source",
	annotations: [],
	schema: null,
	revision: 0,
	onApplySuggestion: () => true,
	onRejectSuggestion: () => true,
};

describe("ChatTab", () => {
	it("aborts and replaces a stale document chat session", async () => {
		const container = document.createElement("div");
		let root: Root;
		await act(async () => {
			root = createRoot(container);
			root.render(<ChatTab {...commonProps} documentEpoch={1} />);
		});
		expect(container.textContent).toContain("Old partial answer");

		await act(async () => {
			root.render(<ChatTab {...commonProps} documentEpoch={2} />);
		});
		expect(oldStop).toHaveBeenCalledOnce();

		// A late chunk mutating the retired session cannot enter the replacement.
		sessions.get("free-document-chat-1")!.messages.push({
			id: "late-answer",
			role: "assistant",
			parts: [{ type: "text", text: "Late stale answer" }],
		});
		await act(async () => {
			root.render(<ChatTab {...commonProps} documentEpoch={2} />);
		});
		expect(container.textContent).not.toContain("Late stale answer");

		await act(async () => root.unmount());
	});

	it("isolates clipboard events from the document-wide PDF editor handlers", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const eventTypes = ["copy", "cut", "paste"] as const;
		const pdfClipboardHandler = vi.fn((event: Event) => event.preventDefault());
		for (const eventType of eventTypes) {
			document.addEventListener(eventType, pdfClipboardHandler);
		}
		const root = createRoot(container);

		try {
			await act(async () => {
				root.render(<ChatTab {...commonProps} documentEpoch={2} />);
			});
			const input = container.querySelector("input");
			expect(input).not.toBeNull();

			for (const eventType of eventTypes) {
				const clipboardEvent = new Event(eventType, {
					bubbles: true,
					cancelable: true,
				});
				input!.dispatchEvent(clipboardEvent);
				expect(clipboardEvent.defaultPrevented).toBe(false);
			}
			expect(pdfClipboardHandler).not.toHaveBeenCalled();
		} finally {
			for (const eventType of eventTypes) {
				document.removeEventListener(eventType, pdfClipboardHandler);
			}
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
