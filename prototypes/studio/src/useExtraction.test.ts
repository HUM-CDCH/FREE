import { describe, expect, it } from "vitest";
import type { ExtractionSchemaEnvelope } from "./api";
import type { ExtractionState } from "./extraction";
import {
	isCurrentExtractionInvocation,
	projectExtractionState,
	type ExtractionIdentity,
	type ExtractionSnapshot,
} from "./useExtraction";

const schema: ExtractionSchemaEnvelope = {
	record: { title: "string" },
	_schema_metadata: {},
};
const identity: ExtractionIdentity = {
	documentEpoch: 0,
	schemaRevision: 0,
	taskId: "task-1",
	schema,
	strategy: "catalog",
};
const ready: ExtractionState = {
	status: "ready",
	result: { title: "Report" },
	warnings: [],
};
const snapshot: ExtractionSnapshot = { ...identity, state: ready };

describe("projectExtractionState", () => {
	it("preserves state when the extraction identity matches", () => {
		expect(projectExtractionState(snapshot, identity)).toBe(ready);
	});

	it("returns idle when the task changes", () => {
		expect(
			projectExtractionState(snapshot, { ...identity, taskId: "task-2" }),
		).toEqual({ status: "idle" });
	});

	it("returns idle when the schema revision changes", () => {
		expect(
			projectExtractionState(snapshot, { ...identity, schemaRevision: 1 }),
		).toEqual({ status: "idle" });
	});

	it("returns idle when the document epoch changes", () => {
		expect(
			projectExtractionState(snapshot, { ...identity, documentEpoch: 1 }),
		).toEqual({ status: "idle" });
	});

	it("returns idle when the schema object changes", () => {
		const equivalentSchema: ExtractionSchemaEnvelope = {
			record: { title: "string" },
			_schema_metadata: {},
		};

		expect(
			projectExtractionState(snapshot, {
				...identity,
				schema: equivalentSchema,
			}),
		).toEqual({ status: "idle" });
	});

	it("returns idle when the strategy changes", () => {
		expect(
			projectExtractionState(snapshot, { ...identity, strategy: "article" }),
		).toEqual({ status: "idle" });
	});
});

describe("isCurrentExtractionInvocation", () => {
	it("rejects a completion from an older schema revision", () => {
		expect(
			isCurrentExtractionInvocation(
				identity,
				{ ...identity, schemaRevision: 1 },
				false,
			),
		).toBe(false);
	});

	it("rejects a completion when identity changed before effect cancellation", () => {
		expect(
			isCurrentExtractionInvocation(
				identity,
				{ ...identity, strategy: "article" },
				false,
			),
		).toBe(false);
	});
});
