import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
	createSchemaAgent,
	createSchemaAgentUIResponse,
} from "./_chat_agent.js";
import { resolveChatModel } from "./_provider.js";

vi.mock("./_provider.js", () => ({
	resolveChatModel: vi.fn(),
}));

describe("createSchemaAgent", () => {
	it("accepts an injected mock model without resolving a live provider", () => {
		const mockModel = {
			specificationVersion: "v4",
			provider: "mock-provider",
			modelId: "mock-chat-model",
		} as unknown as LanguageModel;

		const agent = createSchemaAgent(mockModel);

		expect(agent).toBeDefined();
		expect(resolveChatModel).not.toHaveBeenCalled();
	});

	it("streams validated UI messages with inserted Source Context", async () => {
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "text-1" },
						{ type: "text-delta", id: "text-1", delta: "Bronze pin." },
						{ type: "text-end", id: "text-1" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: 1,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						},
					],
				}),
			}),
		});

		const response = await createSchemaAgentUIResponse({
			uiMessages: [
				{
					id: "question-1",
					role: "user",
					parts: [{ type: "text", text: "What was found?" }],
				},
			],
			options: {
				markdown: "A bronze pin was found.",
				annotations: [{ id: "a-1", text: "bronze pin", pageNumber: 3 }],
				schema: null,
				revision: 0,
				documentEpoch: 2,
			},
			abortSignal: new AbortController().signal,
			model,
		});

		expect(response.headers.get("content-type")).toContain("text/event-stream");
		await expect(response.text()).resolves.toContain("Bronze pin.");
		expect(model.doStreamCalls).toHaveLength(1);
		expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "auto" });
		const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
		expect(prompt).toContain("BEGIN UNTRUSTED SOURCE CONTEXT");
		expect(prompt).toContain("bronze pin");
		expect(prompt.indexOf("BEGIN UNTRUSTED SOURCE CONTEXT")).toBeLessThan(
			prompt.indexOf("What was found?"),
		);
	});

	it("turns valid model proposal content into a server-owned root suggestion", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue(
			"00000000-0000-4000-8000-000000000008",
		);
		const schema = {
			name: "Finds",
			record: { material: "verbatim-string" },
			_schema_metadata: {},
		};
		const model = new MockLanguageModelV4({
			doGenerate: async () => ({
				content: [
					{
						type: "tool-call",
						toolCallId: "call-8",
						toolName: "proposeSchemaChanges",
						input: JSON.stringify({
							summary: "Extract finds",
							proposal: JSON.stringify(schema),
						}),
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: 0,
						cacheWrite: 0,
					},
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			}),
		});

		const result = await createSchemaAgent(model).generate({
			messages: [{ role: "user", content: "Create a schema" }],
			options: {
				markdown: "A bronze pin was found.",
				annotations: [],
				schema: null,
				revision: 3,
				documentEpoch: 2,
			},
		});

		expect(model.doGenerateCalls).toHaveLength(1);
		expect(model.doGenerateCalls[0]?.toolChoice).toEqual({
			type: "tool",
			toolName: "proposeSchemaChanges",
		});
		expect(result.toolResults[0]?.output).toEqual({
			id: "00000000-0000-4000-8000-000000000008",
			documentEpoch: 2,
			baseRevision: 3,
			summary: "Extract finds",
			changes: [{ operation: "set", path: [], value: schema }],
		});
	});

	it("turns valid nested set, rename, and remove content into a server-owned suggestion", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue(
			"00000000-0000-4000-8000-000000000009",
		);
		const approvedSchema = {
			name: "Finds",
			record: {
				material: "verbatim-string",
				obsolete: "verbatim-string",
			},
			_schema_metadata: {},
		};
		const changes = [
			{ operation: "rename", path: ["material"], name: "substance" },
			{ operation: "remove", path: ["obsolete"] },
			{
				operation: "set",
				path: ["period"],
				value: "verbatim-string",
			},
		];
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: "tool-call",
						toolCallId: "call-9",
						toolName: "proposeSchemaChanges",
						input: JSON.stringify({
							summary: "Update finds",
							proposal: JSON.stringify(changes),
						}),
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			},
		});

		const result = await createSchemaAgent(model).generate({
			messages: [{ role: "user", content: "Update the schema" }],
			options: {
				markdown: "Source",
				annotations: [],
				schema: approvedSchema,
				revision: 7,
				documentEpoch: 2,
			},
		});

		expect(result.toolResults[0]?.output).toEqual({
			id: "00000000-0000-4000-8000-000000000009",
			documentEpoch: 2,
			baseRevision: 7,
			summary: "Update finds",
			changes,
		});
	});

	it("rejects a root set against an approved schema", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: "tool-call",
						toolCallId: "root-replacement-9",
						toolName: "proposeSchemaChanges",
						input: JSON.stringify({
							summary: "Replace the approved schema",
							proposal: JSON.stringify([
								{
									operation: "set",
									path: [],
									value: {
										name: "Replacement",
										record: { period: "verbatim-string" },
										_schema_metadata: {},
									},
								},
							]),
						}),
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			},
		});
		const result = await createSchemaAgent(model).generate({
			messages: [{ role: "user", content: "Replace the schema" }],
			options: {
				markdown: "Source",
				annotations: [],
				schema: {
					name: "Finds",
					record: { material: "verbatim-string" },
					_schema_metadata: {},
				},
				revision: 1,
				documentEpoch: 0,
			},
		});

		expect(result.toolResults).toEqual([]);
		expect(result.steps[0]?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "tool-error" })]),
		);
	});

	it("rejects invalid nested proposal output without creating a suggestion", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: "tool-call",
						toolCallId: "bad-9",
						toolName: "proposeSchemaChanges",
						input: JSON.stringify({
							summary: "Break schema",
							proposal: JSON.stringify([
								{ operation: "remove", path: ["missing"] },
							]),
						}),
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			},
		});
		const result = await createSchemaAgent(model).generate({
			messages: [{ role: "user", content: "Remove missing" }],
			options: {
				markdown: "Source",
				annotations: [],
				schema: {
					name: "Finds",
					record: { title: "verbatim-string" },
					_schema_metadata: {},
				},
				revision: 1,
				documentEpoch: 0,
			},
		});

		expect(result.toolResults).toEqual([]);
		expect(result.steps[0]?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "tool-error" })]),
		);
	});

	it("rejects invalid proposal output without creating a suggestion", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: "tool-call",
						toolCallId: "bad-8",
						toolName: "proposeSchemaChanges",
						input: JSON.stringify({
							summary: "Broken",
							proposal: JSON.stringify({ record: {} }),
						}),
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool_calls" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			},
		});
		const result = await createSchemaAgent(model).generate({
			messages: [{ role: "user", content: "Create a schema" }],
			options: {
				markdown: "Source",
				annotations: [],
				schema: null,
				revision: 0,
				documentEpoch: 0,
			},
		});

		expect(result.toolResults).toEqual([]);
		expect(result.steps[0]?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "tool-error" })]),
		);
	});
});
