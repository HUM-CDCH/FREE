import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readExtractionRequest } from "./_extraction_request.js";
import { POST as extractPost } from "./extract.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const baseSchema = { record: { title: "" }, _schema_metadata: {} };

function jsonRequest(body: string, contentLength?: number): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (contentLength !== undefined) {
		headers.set("content-length", String(contentLength));
	}
	return new Request("http://local.test/api/extract", {
		method: "POST",
		body,
		headers,
	});
}

function streamRequest(stream: ReadableStream<Uint8Array>): Request {
	const request = jsonRequest("");
	Object.defineProperty(request, "body", { value: stream });
	return request;
}

function extractionBody(
	schema: unknown = baseSchema,
	padding = "",
): string {
	return JSON.stringify({ taskId: "task-1", schema, strategy: "catalog", padding });
}

function bodyWithByteLength(size: number): string {
	const empty = extractionBody();
	return extractionBody(baseSchema, "x".repeat(size - Buffer.byteLength(empty)));
}

function schemaAtDepth(depth: number): Record<string, unknown> {
	let record: Record<string, unknown> = {};
	for (let current = 3; current <= depth; current += 1) {
		record = { child: record };
	}
	return { record, _schema_metadata: {} };
}

function schemaWithNodes(nodes: number): Record<string, unknown> {
	return {
		record: { values: Array.from({ length: nodes - 4 }, () => 0) },
		_schema_metadata: {},
	};
}

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("readExtractionRequest", () => {
	it.each([
		"FieldReports/Burial_Finds.json",
		"JournalArticles/collagen_extraction.json",
	])("accepts pinned schema %s", async (name) => {
		const input = await readExtractionRequest(
			jsonRequest(extractionBody(fixture(name))),
		);

		expect(input.taskId).toBe("task-1");
	});

	it("accepts a body exactly at the raw-byte limit", async () => {
		const body = bodyWithByteLength(MAX_REQUEST_BYTES);

		await expect(readExtractionRequest(jsonRequest(body))).resolves.toMatchObject({
			taskId: "task-1",
		});
	});

	it("rejects a body one raw byte over the limit", async () => {
		const body = bodyWithByteLength(MAX_REQUEST_BYTES + 1);

		await expect(readExtractionRequest(jsonRequest(body))).rejects.toMatchObject({
			status: 413,
			message: "Extraction request body must not exceed 256 KiB.",
		});
	});

	it("rejects an oversized declared length before reading the body", async () => {
		await expect(
			readExtractionRequest(
				jsonRequest(extractionBody(), MAX_REQUEST_BYTES + 1),
			),
		).rejects.toMatchObject({ status: 413 });
	});

	it("rejects oversized bytes despite a deceptive declared length", async () => {
		const body = bodyWithByteLength(MAX_REQUEST_BYTES + 1);

		await expect(readExtractionRequest(jsonRequest(body, 1))).rejects.toMatchObject({
			status: 413,
		});
	});

	it("accepts schema depth 32 and rejects depth 33", async () => {
		await expect(
			readExtractionRequest(jsonRequest(extractionBody(schemaAtDepth(32)))),
		).resolves.toMatchObject({ taskId: "task-1" });
		await expect(
			readExtractionRequest(jsonRequest(extractionBody(schemaAtDepth(33)))),
		).rejects.toMatchObject({
			status: 400,
			message: "schema must not exceed 32 nested levels.",
		});
	});

	it("accepts 4096 schema nodes and rejects 4097", async () => {
		await expect(
			readExtractionRequest(jsonRequest(extractionBody(schemaWithNodes(4096)))),
		).resolves.toMatchObject({ taskId: "task-1" });
		await expect(
			readExtractionRequest(jsonRequest(extractionBody(schemaWithNodes(4097)))),
		).rejects.toMatchObject({
			status: 400,
			message: "schema must not exceed 4096 structural nodes.",
		});
	});

	it("rejects malformed UTF-8 instead of accepting replacement characters", async () => {
		const bytes = new TextEncoder().encode(extractionBody(baseSchema, "x"));
		bytes[bytes.lastIndexOf("x".charCodeAt(0))] = 0xff;

		await expect(
			readExtractionRequest(
				new Request("http://local.test/api/extract", {
					method: "POST",
					body: bytes,
					headers: { "content-type": "application/json" },
				}),
			),
		).rejects.toMatchObject({ status: 400 });
	});

	it("returns 413 even when oversized-stream cancellation rejects", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
			},
			cancel() {
				return Promise.reject(new Error("cancel failed"));
			},
		});

		await expect(readExtractionRequest(streamRequest(stream))).rejects.toMatchObject({
			status: 413,
		});
	});

	it("maps inbound body stream failures to a client error", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("stream failed"));
			},
		});

		await expect(readExtractionRequest(streamRequest(stream))).rejects.toMatchObject({
			status: 400,
			message: "Could not read extraction request body: stream failed",
		});
	});

	it("rejects malformed JSON", async () => {
		await expect(readExtractionRequest(jsonRequest("{"))).rejects.toMatchObject({
			status: 400,
		});
	});

	it("rejects a non-JSON content type", async () => {
		const request = new Request("http://local.test/api/extract", {
			method: "POST",
			body: extractionBody(),
			headers: { "content-type": "text/plain" },
		});

		await expect(readExtractionRequest(request)).rejects.toMatchObject({
			status: 415,
		});
	});

	it("rejects an oversized route body before downstream calls", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await extractPost(
			jsonRequest(bodyWithByteLength(MAX_REQUEST_BYTES + 1)),
		);

		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			detail: "Extraction request body must not exceed 256 KiB.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
