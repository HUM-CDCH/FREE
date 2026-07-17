import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultsTab from "./ResultsTab";
import type { ExtractionController } from "./useExtraction";
import {
	decodeExtractionResponse,
	decodeSchemaDone,
	parseDocumentToMarkdown,
	requestExtraction,
	requestSchema,
} from "./api";
import { burialFindsPinnedSchema } from "./pinnedSchemas";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function parseBody(init: RequestInit): Record<string, unknown> {
	try {
		return JSON.parse(String(init.body)) as Record<string, unknown>;
	} catch (error) {
		throw new Error("Request body was not valid JSON", { cause: error });
	}
}

afterEach(() => vi.unstubAllGlobals());

function readyController(
	warnings: readonly string[] = [],
): ExtractionController {
	return {
		state: {
			status: "ready",
			result: { title: "Report" },
			warnings,
		},
		canRun: true,
		hasResults: true,
		strategy: "catalog",
		setStrategy: () => undefined,
		runExtraction: async () => {},
	};
}

describe("requestExtraction", () => {
	it("posts task identity, an explicit strategy, and a full schema envelope without Source Document bytes", async () => {
		let submitted: Record<string, unknown> = {};
		let contentType = "";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((_url: string, init: RequestInit) => {
				submitted = parseBody(init);
				contentType = new Headers(init.headers).get("content-type") ?? "";
				return Promise.resolve(
					jsonResponse({ result: { title: "Report" }, warnings: [] }),
				);
			}),
		);

		const { schema, strategy } = burialFindsPinnedSchema;
		expect(schema.record.entries).toBeDefined();
		expect(schema._schema_metadata["record.entries"]).toBeDefined();

		await requestExtraction("task-1", schema, strategy);

		expect(contentType).toBe("application/json");
		expect(submitted).toEqual({
			taskId: "task-1",
			schema,
			strategy,
		});
		expect(JSON.stringify(submitted)).not.toContain("pdf");
	});

	it("throws the API detail on a non-OK response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ detail: "Model endpoint error: boom" }, 502),
				),
		);

		await expect(
			requestExtraction(
				"task-1",
				{ record: {}, _schema_metadata: {} },
				"catalog",
			),
		).rejects.toThrow("Model endpoint error: boom");
	});
});

describe("requestSchema", () => {
	it("calls the existing schema generation endpoint", async () => {
		let submittedUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				submittedUrl = url;
				return Promise.resolve(
					jsonResponse({ template: {}, raw: "", pages: null }),
				);
			}),
		);

		await expect(
			requestSchema(new Blob(["pdf"]), "report.pdf"),
		).resolves.toEqual({
			name: "Generated from source document",
			description: "",
			record: {},
			_schema_metadata: {},
		});

		expect(submittedUrl).toBe("/api/generate_schema");
	});
});

describe("parseDocumentToMarkdown", () => {
	it("starts a job, retains its task ID, polls until completed, and returns Markdown", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				if (url.endsWith("/tasks"))
					return Promise.resolve(jsonResponse({ task_id: "abc" }));
				if (url.endsWith("/tasks/abc"))
					return Promise.resolve(jsonResponse({ status: "completed" }));
				if (url.endsWith("/tasks/abc/markdown"))
					return Promise.resolve(new Response("# Doc"));
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);

		await expect(
			parseDocumentToMarkdown(new Blob(["pdf"]), "report.pdf"),
		).resolves.toEqual({
			taskId: "abc",
			markdown: "# Doc",
		});
	});

	it("throws the job error when parsing fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				if (url.endsWith("/tasks"))
					return Promise.resolve(jsonResponse({ task_id: "abc" }));
				if (url.endsWith("/tasks/abc")) {
					return Promise.resolve(
						jsonResponse({ status: "failed", error: "boom" }),
					);
				}
				return Promise.reject(new Error(`unexpected ${url}`));
			}),
		);

		await expect(
			parseDocumentToMarkdown(new Blob(["pdf"]), "report.pdf"),
		).rejects.toThrow("boom");
	});
});

describe("decoders", () => {
	it("fail loud when response contracts drift", () => {
		expect(() => decodeExtractionResponse({ warnings: [] })).toThrow(
			"invalid 'result'",
		);
		expect(() =>
			decodeExtractionResponse({ result: {}, warnings: [42] }),
		).toThrow("invalid 'warnings'");
		expect(() => decodeSchemaDone({ raw: "{}" })).toThrow(
			"generate_schema: response missing 'template'",
		);
	});
});

describe("ResultsTab", () => {
	it("renders pretty JSON and non-empty warnings without export or format controls", () => {
		const html = renderToStaticMarkup(
			createElement(ResultsTab, {
				controller: readyController(["boundary_fallback"]),
				schemaReady: true,
			}),
		);

		expect(html).toContain("boundary_fallback");
		expect(html).toContain("&quot;title&quot;: &quot;Report&quot;");
		expect(html).not.toContain("Download");
		expect(html).not.toContain("Copy JSON");
		expect(html).not.toContain("Markdown");
	});

	it("does not render an empty warning placeholder", () => {
		const html = renderToStaticMarkup(
			createElement(ResultsTab, {
				controller: readyController(),
				schemaReady: true,
			}),
		);

		expect(html).not.toContain("Extraction warnings");
	});
});
