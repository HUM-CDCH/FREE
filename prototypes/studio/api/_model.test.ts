import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "./_http.js";
import {
	generateSchemaWithModel,
	generateStructuredWithModel,
	editSchemaWithModel,
} from "./_model.js";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return { ...actual, generateText: generateTextMock };
});

const document = {
	file: null,
	markdown: "Grave 1",
	pages: null,
};

function stubOllamaResponse(response: string): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ response }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function requestBody(
	fetchMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
	try {
		return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<
			string,
			unknown
		>;
	} catch (error) {
		throw new Error("Structured model request body was not valid JSON", {
			cause: error,
		});
	}
}

function stubCodexResponse(response: string): void {
	vi.stubEnv("AI_PROVIDER", "codex-cli");
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("Ollama must not be called")),
	);
	generateTextMock.mockResolvedValue({ text: response });
}

beforeEach(() => vi.stubEnv("AI_PROVIDER", "ollama"));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	generateTextMock.mockReset();
});

describe("editSchemaWithModel", () => {
	it("uses raw NuExtract transport for Ollama schema edits", async () => {
		const fetchMock = stubOllamaResponse('{"ops":[{"op":"add","name":"year","type":"date"}]}');
		await expect(editSchemaWithModel({ title: "string" }, "add year")).resolves.toEqual([{ op: "add", name: "year", type: "date" }]);
		const body = requestBody(fetchMock);
		expect(body.raw).toBe(true);
		expect(body.prompt).toContain("add year");
		expect(body.prompt).toContain('"newName":""');
	});

	it("normalizes empty NuExtract template fields for remove and patch operations", async () => {
		stubOllamaResponse('{"ops":[{"op":"remove","name":"obsolete","type":"","newName":null,"parentName":""},{"op":"patch","name":"published","type":"date","newName":"","parentName":null}]}');
		await expect(editSchemaWithModel({ obsolete: "string", published: "string" }, "remove obsolete and make published a date")).resolves.toEqual([
			{ op: "remove", name: "obsolete" },
			{ op: "patch", name: "published", type: "date" },
		]);
	});

	it("uses AI SDK array output for generic providers", async () => {
		stubCodexResponse("unused");
		generateTextMock.mockResolvedValue({ output: [{ op: "remove", name: "obsolete", parentName: "" }] });
		await expect(editSchemaWithModel({ obsolete: "string" }, "remove obsolete")).resolves.toEqual([{ op: "remove", name: "obsolete" }]);
		expect(generateTextMock.mock.calls[0]?.[0].output).toBeDefined();
		expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain("operation array");
	});

	it("rejects malformed operation output", async () => {
		stubOllamaResponse('[{"op":"add","name":"year","type":"made-up"}]');
		await expect(editSchemaWithModel({}, "add year")).rejects.toThrow(/malformed operations/);
	});

	it("forwards cancellation to Ollama", async () => {
		const fetchMock = stubOllamaResponse('[]');
		const controller = new AbortController();
		await editSchemaWithModel({}, "no change", controller.signal);
		expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
	});
});

describe("generateStructuredWithModel", () => {
	it("uses the raw NuExtract boundary and conforms the returned object", async () => {
		const fetchMock = stubOllamaResponse('{"title":"Report","extra":"drop"}');

		const result = await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "", count: 0 },
			instructions: "Extract one report.",
		});

		expect(result).toEqual({ title: "Report", count: null });
		const body = requestBody(fetchMock);
		expect(body.raw).toBe(true);
		expect(body.stream).toBe(false);
		expect(body.prompt).toContain("Extract one report.");
		expect(body.prompt).toContain("Canonical report");
	});

	it("serializes optional AI_NUM_CTX and preserves custom model names", async () => {
		vi.stubEnv("AI_NUM_CTX", "32768");
		vi.stubEnv("AI_MODEL", "custom/operator-qualified-model");
		const fetchMock = stubOllamaResponse('{"title":"Report"}');
		await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "" },
			instructions: "Extract.",
		});
		const body = requestBody(fetchMock);
		expect(body.model).toBe("custom/operator-qualified-model");
		expect(body.options).toEqual(expect.objectContaining({ num_ctx: 32768 }));
	});

	it("omits num_ctx when AI_NUM_CTX is unset", async () => {
		delete process.env.AI_NUM_CTX;
		const fetchMock = stubOllamaResponse('{"title":"Report"}');
		await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "" },
			instructions: "Extract.",
		});
		expect(requestBody(fetchMock).options).not.toHaveProperty("num_ctx");
	});

	it.each([
		"",
		" ",
		"0",
		"-1",
		"1.5",
		"1e3",
		"invalid",
		"9007199254740992",
	])("rejects invalid AI_NUM_CTX=%j before fetch", async (value) => {
		vi.stubEnv("AI_NUM_CTX", value);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			generateStructuredWithModel({
				document: "Canonical report",
				schema: { title: "" },
				instructions: "Extract.",
			}),
		).rejects.toThrow(RequestError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps metadata verbatim in instructions and outside Source Context", async () => {
		const sentinel =
			'Example: Grav 17 has grav_id: 17; preserve "quoted" values.';
		const fetchMock = stubOllamaResponse('{"title":"Report"}');
		await generateStructuredWithModel({
			document: "Canonical Source Context: Grav 8",
			schema: { title: "" },
			instructions: sentinel,
		});
		const prompt = String(requestBody(fetchMock).prompt);
		expect(
			prompt.match(/【instructions_start】([\s\S]*?)【instructions_end】/)?.[1],
		).toContain(sentinel);
		expect(
			prompt.match(/【document_start】([\s\S]*?)【document_end】/)?.[1],
		).not.toContain(sentinel);
	});

	it("forwards cancellation to the raw Ollama request", async () => {
		const fetchMock = stubOllamaResponse('{"title":"Report"}');
		const controller = new AbortController();

		await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "" },
			instructions: "Extract one report.",
			abortSignal: controller.signal,
		});

		expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
	});

	it("routes codex-cli structured extraction through the existing generic model boundary", async () => {
		stubCodexResponse('{"title":"Report"}');

		const result = await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "" },
			instructions: "Extract one report.",
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(generateTextMock).toHaveBeenCalledOnce();
		expect(generateTextMock.mock.calls[0][0]).toHaveProperty("output");
		expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty("temperature");
		expect(result).toEqual({ title: "Report" });
	});

	it("keeps Codex metadata in model instructions and outside Source Context", async () => {
		stubCodexResponse('{"title":"Grav 8"}');
		const sentinel = "Conflicting example: Grav 17";
		const schema = { title: "", allowed_graves: [17] };

		await generateStructuredWithModel({
			document: "Canonical Source Context: Grav 8",
			schema,
			instructions: sentinel,
		});

		const request = generateTextMock.mock.calls[0]?.[0];
		expect(request?.instructions).toContain(sentinel);
		expect(request?.instructions).toContain(JSON.stringify(schema, null, 2));
		const sourceMessage = JSON.stringify(request?.messages);
		expect(sourceMessage).toContain("Canonical Source Context: Grav 8");
		expect(sourceMessage).not.toContain(sentinel);
		expect(sourceMessage).not.toContain("allowed_graves");
	});

	it("forwards cancellation to the AI SDK request", async () => {
		stubCodexResponse('{"title":"Report"}');
		const controller = new AbortController();

		await generateStructuredWithModel({
			document: "Canonical report",
			schema: { title: "" },
			instructions: "Extract one report.",
			abortSignal: controller.signal,
		});

		expect(generateTextMock.mock.calls[0]?.[0].abortSignal).toBe(
			controller.signal,
		);
	});
});

describe("generateSchemaWithModel", () => {
	it("repairs malformed Ollama JSON before returning the extraction schema", async () => {
		stubOllamaResponse('{"grave":[{"name":"verbatim-string"}}]');

		const result = await generateSchemaWithModel({
			document,
			annotations: [],
			annotationsMode: "hints",
		});

		expect(result.template).toEqual({ grave: [{ name: "verbatim-string" }] });
	});

	it("leads the prompt with schema guidance, before the document body", async () => {
		const fetchMock = stubOllamaResponse(
			'{"grave":[{"name":"verbatim-string"}]}',
		);

		await generateSchemaWithModel({
			document,
			annotations: [],
			annotationsMode: "hints",
		});

		const body = fetchMock.mock.calls[0][1].body as string;
		expect(body.indexOf("compact JSON extraction schema")).toBeLessThan(
			body.indexOf("Grave 1"),
		);
	});

	it("routes codex-cli schema suggestions through the AI SDK", async () => {
		stubCodexResponse('{"grave":[{"name":"verbatim-string"}]}');

		const result = await generateSchemaWithModel({
			document,
			annotations: [],
			annotationsMode: "hints",
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(generateTextMock).toHaveBeenCalledOnce();
		expect(result.template).toEqual({ grave: [{ name: "verbatim-string" }] });
	});
});
