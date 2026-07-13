import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWithModel, generateSchemaWithModel } from "./_model.ts";

const document = {
	file: null,
	markdown: "Grave 1",
	pages: null,
};

function stubOllamaResponse(response: string): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ response }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		),
	);
}

function requestPrompt(
	fetchMock: ReturnType<typeof vi.fn>,
	callIndex = 0,
): string {
	const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
	try {
		const parsed: unknown = JSON.parse(String(body));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("prompt" in parsed) ||
			typeof parsed.prompt !== "string"
		) {
			throw new TypeError("request body does not contain a prompt string");
		}
		return parsed.prompt;
	} catch (error) {
		throw new Error(`Cannot inspect Ollama request ${callIndex}.`, {
			cause: error,
		});
	}
}

describe("extractWithModel", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns clean extraction results with source-grounded evidence", async () => {
		stubOllamaResponse('{"grave":[{"name":"Grave 1"}]}');

		const result = await extractWithModel({
			document,
			template: { grave: [{ name: "verbatim-string" }] },
		});

		expect(result.result).toEqual({ grave: [{ name: "Grave 1" }] });
		expect(result.evidence).toEqual({
			grave: [{ name: { value: "Grave 1", snippet: "Grave 1", page: null } }],
		});
	});

	it("uses the model's reasoning mode when structured extraction needs disambiguation", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					response:
						'Ignore the example {"grave":[]}.</think>\n{"grave":[{"name":"Grave 1"}]}',
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await extractWithModel({
			document,
			template: { grave: [{ name: "verbatim-string" }] },
			enableThinking: true,
		});

		expect(requestPrompt(fetchMock)).toMatch(/<think>\n$/);
		expect(result.result).toEqual({ grave: [{ name: "Grave 1" }] });
	});

	it("extracts repeated Markdown records independently and merges them in source order", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: '{"entries":[{"Grav_id":"8"}]}',
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: '{"entries":[{"Grav_id":"13"}]}',
					}),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await extractWithModel({
			document: {
				file: null,
				markdown: "# Grav 8\nArk: 67\n# Grav 13\nArk: 24",
				pages: null,
			},
			template: { entries: [{ Grav_id: "verbatim-string" }] },
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstPrompt = requestPrompt(fetchMock);
		const secondPrompt = requestPrompt(fetchMock, 1);
		expect(firstPrompt).toContain("# Grav 8");
		expect(firstPrompt).not.toContain("# Grav 13");
		expect(secondPrompt).toContain("# Grav 13");
		expect(result.result).toEqual({
			entries: [{ Grav_id: "8" }, { Grav_id: "13" }],
		});
		expect(result.evidence).toEqual({
			entries: [
				{ Grav_id: { value: "8", snippet: "# Grav 8", page: null } },
				{ Grav_id: { value: "13", snippet: "# Grav 13", page: null } },
			],
		});
	});

	it("retries only records whose extracted child array mixes table schemas", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response:
							'{"entries":[{"Grav_id":"8","fundliste":[{"Fund_no":"8-1"},{"Fund_no":"8-2"}]}]}',
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response:
							'Use only Fundnummer.</think>\n{"entries":[{"Grav_id":"8","fundliste":[{"Fund_no":"8-2"}]}]}',
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: '{"entries":[{"Grav_id":"13","fundliste":[]}]}',
					}),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await extractWithModel({
			document: {
				file: null,
				markdown: [
					"# Grav 8",
					"| Nummer | Beskrivelse |",
					"| --- | --- |",
					"| 8-1 | Kæbe |",
					"",
					"| Fundnummer | Beskrivelse |",
					"| --- | --- |",
					"| 8-2 | Jern |",
					"# Grav 13",
					"Ingen fundliste.",
				].join("\n"),
				pages: null,
			},
			template: {
				entries: [
					{
						Grav_id: "verbatim-string",
						fundliste: [{ Fund_no: "verbatim-string" }],
					},
				],
			},
			enableThinking: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(requestPrompt(fetchMock, 1)).toMatch(/<think>\n$/);
		expect(requestPrompt(fetchMock, 2)).toMatch(/<think>\n\n<\/think>\n\n$/);
		expect(result.result).toEqual({
			entries: [
				{ Grav_id: "8", fundliste: [{ Fund_no: "8-2" }] },
				{ Grav_id: "13", fundliste: [] },
			],
		});
	});

	it("rejects fields outside the extraction schema", async () => {
		stubOllamaResponse('{"grave":[{"name":"Grave 1","extra":"invented"}]}');

		await expect(
			extractWithModel({
				document,
				template: { grave: [{ name: "verbatim-string" }] },
			}),
		).rejects.toThrow(
			"Model returned output that did not match the extraction schema.",
		);
	});

	it("rejects primitive values with the wrong extraction-schema type", async () => {
		stubOllamaResponse('{"grave":[{"name":42}]}');

		await expect(
			extractWithModel({
				document,
				template: { grave: [{ name: "verbatim-string" }] },
			}),
		).rejects.toThrow(
			"Model returned output that did not match the extraction schema.",
		);
	});
});

describe("generateSchemaWithModel", () => {
	afterEach(() => vi.unstubAllGlobals());

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
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ response: '{"grave":[{"name":"verbatim-string"}]}' }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await generateSchemaWithModel({
			document,
			annotations: [],
			annotationsMode: "hints",
		});

		const prompt = requestPrompt(fetchMock);
		expect(prompt.indexOf("compact JSON extraction schema")).toBeLessThan(
			prompt.indexOf("Grave 1"),
		);
	});
});
