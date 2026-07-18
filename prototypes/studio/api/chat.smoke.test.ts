import { readFileSync } from "node:fs";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";
import type { SchemaAgentUIMessage } from "../shared/schema-agent-message.js";
import { POST } from "./chat.js";

const runLiveSmoke = process.env.RUN_CHAT_SMOKE === "1";
const sourceContext = readFileSync(
	new URL("./test-fixtures/chat-ellekilde.md", import.meta.url),
	"utf8",
);

function messageText(message: SchemaAgentUIMessage): string {
	return message.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("");
}

const transport = new DefaultChatTransport<SchemaAgentUIMessage>({
	api: "http://local.test/api/chat",
	fetch: async (input, init) => POST(new Request(input, init)),
});

describe.skipIf(!runLiveSmoke)("live Ellekilde chat smoke", () => {
	it("keeps a grounded conversation and proposes an Extraction Schema", async () => {
		const messages: SchemaAgentUIMessage[] = [];

		async function send(text: string): Promise<SchemaAgentUIMessage> {
			const userMessage: SchemaAgentUIMessage = {
				id: `researcher-${messages.length}`,
				role: "user",
				parts: [{ type: "text", text }],
			};
			messages.push(userMessage);
			const stream = await transport.sendMessages({
				trigger: "submit-message",
				chatId: "ellekilde-smoke",
				messageId: userMessage.id,
				messages,
				abortSignal: AbortSignal.timeout(180_000),
				body: {
					markdown: sourceContext,
					annotations: [],
					schema: null,
					revision: 0,
					documentEpoch: 0,
				},
			});
			let assistantMessage: SchemaAgentUIMessage | undefined;
			const streamErrors: unknown[] = [];
			for await (const current of readUIMessageStream<SchemaAgentUIMessage>({
				stream,
				onError: (error) => streamErrors.push(error),
				terminateOnError: true,
			})) {
				assistantMessage = current;
			}
			if (!assistantMessage) {
				throw new Error(
					`Chat produced no assistant message: ${streamErrors.map(String).join(", ") || "empty stream"}`,
				);
			}
			messages.push(assistantMessage);
			return assistantMessage;
		}

		const graves = messageText(
			await send(
				"Which graves are described in this Source Context? Answer with the grave numbers.",
			),
		);
		expect(graves).toMatch(/\b8\b/);
		expect(graves).toMatch(/\b13\b/);

		const equipment = messageText(
			await send(
				"What grave equipment was found in Grave 8, and what grave equipment was found in Grave 13?",
			),
		).toLowerCase();
		expect(equipment).toMatch(/jernspænde|iron buckle/);
		expect(equipment).toMatch(/intet|none|no grave equipment/);

		const schemaProposal = await send(
			"Create an Extraction Schema for these burial records. Include grave number, orientation, skeletal remains, age estimate, grave equipment, interpretation, period, and page reference.",
		);
		expect(
			schemaProposal.parts.some(
				(part) =>
					part.type === "tool-proposeSchemaChanges" &&
					part.state === "output-available",
			),
		).toBe(true);
	}, 300_000);
});
