import { describe, expect, it } from "vitest";
import burialFindsSchema from "../schemas/FieldReports/Burial_Finds.json";
import collagenExtractionSchema from "../schemas/JournalArticles/collagen_extraction.json";
import {
	applySchemaChanges,
	applySchemaSuggestion,
	validateExtractionSchema,
	type ExtractionSchemaEnvelope,
} from "./schema";

const baseSchema: ExtractionSchemaEnvelope = {
	record: {
		title: "",
		entries: [
			{
				name: "",
				_evidence: {
					name: {
						snippets: [],
						inferred: false,
						source_type: "",
						page: null,
						table_index: null,
						row_index: null,
						col_index: null,
						row_header_text: "",
						column_header_text: "",
					},
				},
			},
		],
	},
	_schema_metadata: {},
};

describe("Extraction Schema validation", () => {
	it.each([
		["Burial Finds", burialFindsSchema],
		["collagen extraction", collagenExtractionSchema],
	])("accepts the pinned %s fixture's complete recursive grammar", (_name, schema) => {
		expect(validateExtractionSchema(schema)).toEqual({
			valid: true,
			issues: [],
		});
	});

	it.each([
		["malformed field array", { ...baseSchema, record: { title: [""] } }],
		[
			"malformed Evidence",
			{ ...baseSchema, record: { title: "", _evidence: "bad" } },
		],
		[
			"orphaned Evidence",
			{ ...baseSchema, record: { title: "", _evidence: { missing: {} } } },
		],
		[
			"malformed metadata",
			{ ...baseSchema, _schema_metadata: { "record.title": 1 } },
		],
		[
			"orphaned metadata",
			{ ...baseSchema, _schema_metadata: { "record.missing": {} } },
		],
	])("rejects %s", (_name, schema) => {
		expect(validateExtractionSchema(schema).valid).toBe(false);
	});
});

describe("set schema changes", () => {
	it("immutably adds a normalized leaf beneath an existing repeated-item record with local Evidence", () => {
		const result = applySchemaChanges(baseSchema, [
			{
				operation: "set",
				path: ["entries", " Sample Label "],
				value: "string",
			},
		]);

		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(result.schema).not.toBe(baseSchema);
		expect(result.schema.record.entries).toEqual([
			expect.objectContaining({
				sample_label: "string",
				_evidence: expect.objectContaining({
					sample_label: {
						snippets: [],
						inferred: false,
						source_type: "",
						page: null,
						table_index: null,
						row_index: null,
						col_index: null,
						row_header_text: "",
						column_header_text: "",
					},
				}),
			}),
		]);
		expect(baseSchema.record.entries).not.toHaveProperty("0.sample_label");
	});

	it("retypes an existing field without normalizing its loaded name", () => {
		const result = applySchemaChanges(baseSchema, [
			{ operation: "set", path: ["entries", "name"], value: null },
		]);
		expect(result).toMatchObject({
			status: "applied",
			schema: { record: { entries: [{ name: null }] } },
		});
	});

	it.each([
		"_evidence",
		"_meta",
		"_schema_metadata",
		"__proto__",
		"constructor",
		"prototype",
	])("rejects protected field name %s with a typed issue", (name) => {
		const result = applySchemaChanges(baseSchema, [
			{ operation: "set", path: [name], value: "" },
		]);
		expect(result).toMatchObject({
			status: "invalid",
			issues: [{ path: [name] }],
		});
	});

	it("rejects duplicate normalized names and never overwrites an existing field", () => {
		const result = applySchemaChanges(baseSchema, [
			{ operation: "set", path: [" TITLE "], value: "number" },
		]);
		expect(result).toMatchObject({
			status: "invalid",
			issues: [{ code: "field_exists" }],
		});
		expect(baseSchema.record.title).toBe("");
	});

	it("rejects malformed paths and missing parents", () => {
		for (const change of [
			{ operation: "set" as const, path: [""], value: "" },
			{ operation: "set" as const, path: ["missing", "leaf"], value: "" },
		]) {
			expect(applySchemaChanges(baseSchema, [change]).status).toBe("invalid");
		}
	});

	it("atomically rejects a nested set that creates malformed Evidence", () => {
		const result = applySchemaChanges(baseSchema, [
			{
				operation: "set",
				path: ["entries"],
				value: [{ name: "", _evidence: "bad" }],
			},
		]);
		expect(result.status).toBe("invalid");
		expect(baseSchema.record.entries).toEqual([
			expect.objectContaining({ name: "" }),
		]);
	});

	it("rejects a malformed root replacement with an orphaned metadata reference", () => {
		const result = applySchemaChanges(baseSchema, [
			{
				operation: "set",
				path: [],
				value: {
					record: { title: "" },
					_schema_metadata: { "record.missing": {} },
				},
			},
		]);
		expect(result.status).toBe("invalid");
	});

	it("rejects stale suggestions before applying changes", () => {
		const result = applySchemaSuggestion(
			baseSchema,
			{ documentEpoch: 2, revision: 4 },
			{
				id: "suggestion",
				documentEpoch: 2,
				baseRevision: 3,
				summary: "Retype",
				changes: [{ operation: "set", path: ["title"], value: null }],
			},
		);
		expect(result).toEqual({ status: "stale" });
	});
});
