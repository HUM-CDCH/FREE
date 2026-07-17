import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createSchemaAgent } from "./_chat_agent.js";
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
});
