import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
	generateSchemaWithModel,
	generateStructuredWithModel,
} from "../api/_model";
import { createSchemaAgentUIResponse } from "../api/_chat_agent";
import { POST as chatPost } from "../api/chat";
import { POST as extractPost } from "../api/extract";
import { POST as schemaPost } from "../api/generate_schema";
import { GET as healthGet } from "../api/healthz";

vi.mock("../api/_model", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/_model")>();
	return {
		...actual,
		generateSchemaWithModel: vi.fn(),
		generateStructuredWithModel: vi.fn(),
	};
});

vi.mock("../api/_chat_agent", () => ({
	createSchemaAgentUIResponse: vi.fn(),
}));

const schema = {
	record: { notes: "", entries: [{ id: "", _evidence: {} }] },
	_schema_metadata: {
		"record.entries": { instance_description: "Each heading is one entry." },
	},
};

function canonicalDocument(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: "parsed_document.v1",
		text_views: { llm_markdown: "# Item 1\n\nBody" },
		pages: [
			{
				page: 1,
				text: "Item 1 Body",
				markdown: "# Item 1\n\nBody",
				char_span: { llm_markdown_start: 0, llm_markdown_end: 15 },
			},
		],
		tables: [],
		evidence_index: { anchors: [] },
		...overrides,
	};
}

function extractionRequest(
	body: Record<string, unknown> = {
		taskId: "task-1",
		schema,
		strategy: "catalog",
	},
	signal?: AbortSignal,
): Request {
	return new Request("http://local.test/api/extract", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		signal,
	});
}

function formRequest(endpoint: string): Request {
	const form = new FormData();
	form.append(
		"file",
		new Blob(["%PDF"], { type: "application/pdf" }),
		"report.pdf",
	);
	return new Request(`http://local.test/api/${endpoint}`, {
		method: "POST",
		body: form,
	});
}

function stubParsingService(
	body: unknown,
	status = 200,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Vercel API endpoints", () => {
	it("GET /api/healthz returns ok", async () => {
		const response = healthGet();

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: "ok" });
	});

	it("POST /api/extract fetches the canonical task and returns exactly result plus warnings", async () => {
		vi.stubEnv("PARSING_SERVICE_URL", "http://parser.test/");
		const fetchMock = stubParsingService(canonicalDocument());
		vi.mocked(generateStructuredWithModel)
			.mockResolvedValueOnce({
				records: [{ record_id: "1", start_marker: "# Item 1", end_marker: "" }],
			})
			.mockResolvedValueOnce({ id: "1", _evidence: {} });

		const response = await extractPost(extractionRequest());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			result: { notes: null, entries: [{ id: "1", _evidence: {} }] },
			warnings: [],
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://parser.test/tasks/task-1/parsed-document",
			{
				headers: { accept: "application/json" },
				signal: expect.any(AbortSignal),
			},
		);
		expect(generateStructuredWithModel).toHaveBeenCalledTimes(2);
	});

	it("propagates browser cancellation to the canonical document request", async () => {
		const controller = new AbortController();
		let downstreamSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				downstreamSignal = init?.signal ?? undefined;
				if (downstreamSignal === undefined)
					return Promise.reject(new Error("Missing cancellation signal."));
				return new Promise<Response>((_resolve, reject) => {
					downstreamSignal?.addEventListener(
						"abort",
						() => reject(downstreamSignal?.reason),
						{ once: true },
					);
				});
			}),
		);

		const pending = extractPost(
			extractionRequest(undefined, controller.signal),
		);
		await vi.waitFor(() => expect(downstreamSignal).toBeDefined());
		controller.abort(new DOMException("cancelled", "AbortError"));
		await pending;

		expect(downstreamSignal?.aborted).toBe(true);
	});

	it("propagates browser cancellation to Article generation", async () => {
		stubParsingService(canonicalDocument());
		const controller = new AbortController();
		let downstreamSignal: AbortSignal | undefined;
		vi.mocked(generateStructuredWithModel).mockImplementationOnce((input) => {
			downstreamSignal = input.abortSignal;
			if (downstreamSignal === undefined)
				return Promise.reject(new Error("Missing cancellation signal."));
			return new Promise<Record<string, unknown>>((_resolve, reject) => {
				downstreamSignal?.addEventListener(
					"abort",
					() => reject(downstreamSignal?.reason),
					{ once: true },
				);
			});
		});

		const pending = extractPost(
			extractionRequest(
				{ taskId: "task-1", schema, strategy: "article" },
				controller.signal,
			),
		);
		await vi.waitFor(() => expect(downstreamSignal).toBeDefined());
		controller.abort(new DOMException("cancelled", "AbortError"));
		await pending;

		expect(downstreamSignal?.aborted).toBe(true);
	});

	it("grounds Catalog table Evidence globally instead of trusting section-local table hints", async () => {
		stubParsingService(
			canonicalDocument({
				tables: [
					{
						table_id: "table-1",
						page_number: 1,
						cells: [
							{ row: 0, col: 0, text: "ID", role: "column_header" },
							{ row: 1, col: 0, text: "other", role: "data" },
						],
					},
					{
						table_id: "table-2",
						page_number: 2,
						cells: [
							{ row: 0, col: 0, text: "ID", role: "column_header" },
							{ row: 1, col: 0, text: "target", role: "data" },
						],
					},
				],
			}),
		);
		vi.mocked(generateStructuredWithModel)
			.mockResolvedValueOnce({
				records: [{ record_id: "1", start_marker: "# Item 1", end_marker: "" }],
			})
			.mockResolvedValueOnce({
				id: "target",
				_evidence: {
					id: {
						snippets: ["| ID | target |"],
						source_type: "table",
						page: 1,
						table_index: 1,
						row_index: 1,
						col_index: 0,
					},
				},
			});

		const response = await extractPost(extractionRequest());
		const body = await response.json();
		const result = body.result as Record<string, unknown>;
		const entry = (result.entries as Array<Record<string, unknown>>)[0];
		const evidence = (
			entry?._evidence as Record<string, Record<string, unknown>>
		).id;

		expect(response.status).toBe(200);
		expect(evidence).toEqual(
			expect.objectContaining({
				page: 2,
				table_index: 2,
				row_index: 1,
				col_index: 0,
			}),
		);
	});

	it("maps an incomplete parsing task and does not invoke the model", async () => {
		stubParsingService(
			{
				detail: "Task is in status 'running' and parsed document is not ready.",
			},
			400,
		);

		const response = await extractPost(extractionRequest());

		expect(response.status).toBe(409);
		expect(generateStructuredWithModel).not.toHaveBeenCalled();
	});

	it("rejects an unsupported strategy before fetching or invoking the model", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await extractPost(
			extractionRequest({ taskId: "task-1", schema, strategy: "automatic" }),
		);

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(generateStructuredWithModel).not.toHaveBeenCalled();
	});

	it("rejects a plain record template instead of accepting a non-envelope schema", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await extractPost(
			extractionRequest({
				taskId: "task-1",
				schema: { entries: [] },
				strategy: "catalog",
			}),
		);

		expect(response.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails invalid canonical contracts before model invocation", async () => {
		stubParsingService(
			canonicalDocument({ schema_version: "parsed_document.v2" }),
		);

		const response = await extractPost(extractionRequest());

		expect(response.status).toBe(502);
		expect(generateStructuredWithModel).not.toHaveBeenCalled();
	});

	it("routes article explicitly through one whole-document model call despite record.entries", async () => {
		stubParsingService(canonicalDocument());
		vi.mocked(generateStructuredWithModel).mockResolvedValueOnce({
			notes: "article",
			entries: [{ id: "article-1", _evidence: {} }],
		});

		const response = await extractPost(
			extractionRequest({ taskId: "task-1", schema, strategy: "article" }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			result: {
				notes: "article",
				entries: [{ id: "article-1", _evidence: {} }],
			},
			warnings: [],
		});
		expect(generateStructuredWithModel).toHaveBeenCalledOnce();
	});

	it("conforms and canonically grounds Article output in exactly one call", async () => {
		const articleSchema = {
			record: {
				summary: "",
				details: { required: "", optional: "" },
				entries: [
					{
						value: "",
						page_note: "",
						_evidence: {
							value: {
								snippets: [""],
								source_type: "",
								page: 0,
								table_index: 0,
								row_index: 0,
								col_index: 0,
								row_header_text: "",
								column_header_text: "",
							},
							page_note: { snippets: [""], source_type: "", page: 0 },
						},
					},
				],
			},
			_schema_metadata: {
				sentinel: { instance_description: "Grav 17 is only an example." },
			},
		};
		stubParsingService(
			canonicalDocument({
				pages: [
					{
						page: 3,
						text: "Target note",
						markdown: "Target note",
						char_span: { llm_markdown_start: 0, llm_markdown_end: 11 },
					},
				],
				text_views: { llm_markdown: "Target note" },
				tables: [
					{
						table_id: "table-1",
						page_number: 3,
						cells: [
							{ row: 0, col: 0, text: "Metric", role: "column_header" },
							{ row: 1, col: 0, text: "target", role: "data" },
						],
					},
				],
			}),
		);
		vi.mocked(generateStructuredWithModel).mockResolvedValueOnce({
			summary: "article",
			details: { required: "present", unknown: "drop" },
			unknown: "drop",
			entries: [
				{
					value: "target",
					page_note: "Target note",
					_evidence: {
						value: {
							snippets: ["| Metric | target |"],
							source_type: "table",
							page: 99,
							table_index: 99,
							row_index: 50,
							col_index: 50,
						},
						page_note: { snippets: [], source_type: "text", page: 3 },
					},
				},
			],
		});

		const response = await extractPost(
			extractionRequest({
				taskId: "task-1",
				schema: articleSchema,
				strategy: "article",
			}),
		);
		const body = await response.json();
		const entry = body.result.entries[0];

		expect(response.status).toBe(200);
		expect(generateStructuredWithModel).toHaveBeenCalledOnce();
		expect(body.warnings).toEqual([]);
		expect(body.result).toEqual(
			expect.objectContaining({
				summary: "article",
				details: { required: "present", optional: null },
			}),
		);
		expect(body.result).not.toHaveProperty("unknown");
		expect(entry._evidence.value).toEqual(
			expect.objectContaining({
				page: 3,
				table_index: 1,
				row_index: 1,
				col_index: 0,
			}),
		);
		expect(entry._evidence.page_note).toEqual(
			expect.objectContaining({ snippets: [], page: 3 }),
		);
	});

	it("POST /api/generate_schema returns the documented JSON shape", async () => {
		vi.mocked(generateSchemaWithModel).mockResolvedValue({
			template: { title: "verbatim-string" },
			raw: '{"template":{"title":"verbatim-string"}}',
			pages: null,
		});

		const response = await schemaPost(formRequest("generate_schema"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			suggestionId: expect.any(String),
			template: { title: "verbatim-string" },
			raw: '{"template":{"title":"verbatim-string"}}',
			pages: null,
		});
	});

	it("POST /api/chat returns the mocked UI message stream response", async () => {
		vi.mocked(createSchemaAgentUIResponse).mockResolvedValue(
			new Response("stream"),
		);
		const messages: UIMessage[] = [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
		];

		const response = await chatPost(
			new Request("http://local.test/api/chat", {
				method: "POST",
				body: JSON.stringify({
					messages,
					markdown: null,
					annotations: [],
					schema: null,
					revision: 0,
					documentEpoch: 0,
				}),
				headers: { "content-type": "application/json" },
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("stream");
	});
});
