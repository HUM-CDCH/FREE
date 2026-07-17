import { describe, expect, it } from "vitest";
import {
	applySchemaChanges,
	type ExtractionSchemaEnvelope,
} from "../shared/schema";
import { fieldEditChanges } from "./schemaFieldEdits";

const evidence = {
	snippets: [],
	inferred: false,
	source_type: "",
	page: null,
	table_index: null,
	row_index: null,
	col_index: null,
	row_header_text: "",
	column_header_text: "",
};

const schema: ExtractionSchemaEnvelope = {
	record: {
		group: {
			child: "string",
			_evidence: { child: evidence },
		},
		items: [
			{
				label: "string",
				_evidence: { label: evidence },
			},
		],
	},
	_schema_metadata: {
		"record.group.child": { description: "Nested child" },
		"record.items[].label": { description: "Repeated label" },
	},
};

describe("fieldEditChanges", () => {
	it("renames an object without replacing its contents or references", () => {
		const changes = fieldEditChanges(
			["group"],
			schema.record.group,
			"renamed_group",
			"object",
		);

		expect(changes).toEqual([
			{ operation: "rename", path: ["group"], name: "renamed_group" },
		]);
		const result = applySchemaChanges(schema, changes);
		expect(result).toEqual({
			status: "applied",
			schema: {
				record: {
					renamed_group: {
						child: "string",
						_evidence: { child: evidence },
					},
					items: schema.record.items,
				},
				_schema_metadata: {
					"record.renamed_group.child": { description: "Nested child" },
					"record.items[].label": { description: "Repeated label" },
				},
			},
		});
	});

	it("renames an array without replacing its repeated contents or references", () => {
		const changes = fieldEditChanges(
			["items"],
			schema.record.items,
			"renamed_items",
			"array",
		);

		expect(changes).toEqual([
			{ operation: "rename", path: ["items"], name: "renamed_items" },
		]);
		const result = applySchemaChanges(schema, changes);
		expect(result).toMatchObject({
			status: "applied",
			schema: {
				record: {
					renamed_items: [{ label: "string", _evidence: { label: evidence } }],
				},
				_schema_metadata: {
					"record.renamed_items[].label": { description: "Repeated label" },
				},
			},
		});
	});

	it("does nothing when an unchanged object edit is saved", () => {
		expect(
			fieldEditChanges(["group"], schema.record.group, "group", "object"),
		).toEqual([]);
	});
});
