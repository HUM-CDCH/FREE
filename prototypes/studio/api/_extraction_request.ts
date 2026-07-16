import type { ExtractionSchemaEnvelope } from "./_catalog.js";
import { RequestError } from "./_http.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4096;

export type ExtractionStrategy = "catalog" | "article";

export type ExtractionRequest = {
	readonly taskId: string;
	readonly schema: ExtractionSchemaEnvelope;
	readonly strategy: ExtractionStrategy;
};

export async function readExtractionRequest(
	request: Request,
): Promise<ExtractionRequest> {
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	) {
		throw new RequestError(415, "Content-Type must be application/json.");
	}

	const value = parseJson(await readBoundedBody(request));
	if (!isRecord(value))
		throw new RequestError(400, "Request body must be a JSON object.");
	const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
	if (!taskId)
		throw new RequestError(400, "taskId must be a non-empty string.");
	if (value.strategy !== "catalog" && value.strategy !== "article") {
		throw new RequestError(400, "strategy must be 'catalog' or 'article'.");
	}
	if (
		!isRecord(value.schema) ||
		!isRecord(value.schema.record) ||
		!isRecord(value.schema._schema_metadata)
	) {
		throw new RequestError(
			400,
			"schema must be a full Extraction Schema envelope with object fields record and _schema_metadata.",
		);
	}
	assertSchemaComplexity(value.schema);

	return {
		taskId,
		schema: {
			record: value.schema.record,
			_schema_metadata: value.schema._schema_metadata,
		},
		strategy: value.strategy,
	};
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
	const contentLength = request.headers.get("content-length");
	const declaredBytes = contentLength === null ? null : Number(contentLength);
	if (
		declaredBytes !== null &&
		Number.isSafeInteger(declaredBytes) &&
		declaredBytes > MAX_REQUEST_BYTES
	) {
		throw bodyTooLarge();
	}

	if (request.body === null) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				throw new RequestError(
					400,
					`Could not read extraction request body: ${error instanceof Error ? error.message : "stream failed"}`,
				);
			}
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_REQUEST_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw bodyTooLarge();
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof TypeError) {
			throw new RequestError(400, `Request body is not valid JSON: ${error.message}`);
		}
		throw error;
	}
}

function assertSchemaComplexity(schema: Record<string, unknown>): void {
	const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
		{ value: schema, depth: 1 },
	];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		nodes += 1;
		if (nodes > MAX_SCHEMA_NODES) {
			throw new RequestError(
				400,
				`schema must not exceed ${MAX_SCHEMA_NODES} structural nodes.`,
			);
		}
		if (current.depth > MAX_SCHEMA_DEPTH) {
			throw new RequestError(
				400,
				`schema must not exceed ${MAX_SCHEMA_DEPTH} nested levels.`,
			);
		}

		const children = Array.isArray(current.value)
			? current.value
			: isRecord(current.value)
				? Object.values(current.value)
				: [];
		for (const child of children) {
			stack.push({ value: child, depth: current.depth + 1 });
		}
	}
}

function bodyTooLarge(): RequestError {
	return new RequestError(
		413,
		"Extraction request body must not exceed 256 KiB.",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
