import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	catalogFingerprint,
	extractCatalog,
	inferPrimaryRepeatedArray,
	mergeCatalogOutputs,
	resolveCatalogBoundaries,
	sliceCatalogSections,
	type ExtractionSchemaEnvelope,
} from "./_catalog.js";
import { fixture } from "./_fixtures.js";

const burial = fixture<ExtractionSchemaEnvelope>(
	"../../schemas/FieldReports/Burial_Finds.json",
);
const markdown = readFileSync(
	new URL("./test-fixtures/catalog-two-records.md", import.meta.url),
	"utf8",
);
const boundaries = fixture<Record<string, unknown>>("catalog-boundaries.json");
const records = fixture<Record<string, unknown>[]>("catalog-records.json");

describe("Catalog pinned pure behavior", () => {
	it("selects Burial Finds record.entries", () => {
		expect(
			inferPrimaryRepeatedArray(burial.record, burial._schema_metadata)?.key,
		).toBe("entries");
	});

	it("prefers richer metadata and preserves declaration order for ties", () => {
		const record = { first: [{ id: "" }], second: [{ id: "" }] };
		expect(
			inferPrimaryRepeatedArray(record, {
				"record.first": { instance_description: "short" },
				"record.second": { instance_description: "a much richer description" },
			})?.key,
		).toBe("second");
		expect(inferPrimaryRepeatedArray(record, {})?.key).toBe("first");
	});

	it("resolves and slices boundaries in source order", () => {
		const resolved = resolveCatalogBoundaries(markdown, boundaries);
		const sections = sliceCatalogSections(markdown, resolved);

		expect(sections.map((section) => section.recordId)).toEqual(["8", "13"]);
		expect(sections[0]?.text).toContain("# Grav 8");
		expect(sections[0]?.text).not.toContain("# Grav 13");
		expect(sections[1]?.text).toContain("# Grav 13");
	});

	it("preserves boundaries that resolve to the same start", () => {
		const duplicate = {
			records: [
				(boundaries.records as unknown[])[0],
				{ record_id: "duplicate", start_marker: "# Grav 8" },
				(boundaries.records as unknown[])[1],
			],
		};

		const sections = sliceCatalogSections(
			markdown,
			resolveCatalogBoundaries(markdown, duplicate),
		);

		expect(sections.map((section) => section.recordId)).toEqual([
			"8",
			"duplicate",
			"13",
		]);
	});

	it("coerces scalar boundary markers like the pinned Python parser", () => {
		const resolved = resolveCatalogBoundaries("123 body", {
			records: [{ record_id: 123, label: 123, start_marker: 123 }],
		});
		expect(resolved).toEqual([
			expect.objectContaining({ recordId: "123", label: "123", startIndex: 0 }),
		]);
	});

	it("drops unresolved markers while slicing remaining records in source order", () => {
		const partial = {
			records: [
				...(boundaries.records as unknown[]),
				{ record_id: "missing", start_marker: "# Missing", end_marker: "" },
			],
		};
		const resolved = resolveCatalogBoundaries(markdown, partial);
		expect(resolved.map((item) => item.recordId)).toEqual(["8", "13"]);
	});

	it("merges in order and applies scalar fingerprint deduplication", () => {
		const merged = mergeCatalogOutputs(
			[...records, records[0]!],
			burial,
			"entries",
		);
		const entries = merged.entries as Array<Record<string, unknown>>;

		expect(entries.map((entry) => entry.Grav_id)).toEqual(["8", "13"]);
		const firstFind = (
			entries[0]?.fundliste as Array<Record<string, unknown>>
		)[0];
		expect(firstFind).toEqual(
			expect.objectContaining({
				Fund_no: "8-2",
				Fund_beskrivelse: "Jernspænde",
			}),
		);
		expect((firstFind?._evidence as Record<string, unknown>).Fund_no).toEqual(
			expect.objectContaining({ snippets: ["8-2"], table_index: 1 }),
		);
		expect(merged.global_notes).toBeNull();
	});

	it("fingerprints nested arrays by length and ignores evidence objects", () => {
		expect(
			catalogFingerprint({
				id: "8",
				children: [{ value: "a" }],
				_evidence: { id: "one" },
			}),
		).toBe(
			catalogFingerprint({
				id: "8",
				children: [{ value: "b" }],
				_evidence: { id: "two" },
			}),
		);
	});
});

describe("extractCatalog orchestration", () => {
	it("preserves complete metadata verbatim in every instructions payload", async () => {
		const sentinel = `Grav 17 example: grav_id 17; ${"x".repeat(1300)}`;
		const schemaWithSentinel: ExtractionSchemaEnvelope = {
			record: { entries: [{ id: "" }] },
			_schema_metadata: {
				"record.entries": {
					instance_description: "Each heading is one entry.",
				},
				unrelated_guidance: { example: sentinel },
			},
		};
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "1", start_marker: "# Item" }],
			})
			.mockResolvedValueOnce({ id: "1" });

		await extractCatalog({
			document: "# Item",
			schema: schemaWithSentinel,
			generate,
		});

		const serialized = JSON.stringify(schemaWithSentinel._schema_metadata);
		expect(generate).toHaveBeenCalledTimes(2);
		for (const [input] of generate.mock.calls)
			expect(input.instructions).toContain(serialized);
	});

	it("propagates cancellation without retrying a record", async () => {
		const controller = new AbortController();
		const cancellation = new DOMException("cancelled", "AbortError");
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "8", start_marker: "# Grav 8", end_marker: "" }],
			})
			.mockImplementationOnce(async () => {
				controller.abort(cancellation);
				throw controller.signal.reason;
			});

		await expect(
			extractCatalog({
				document: markdown,
				schema: burial,
				generate,
				abortSignal: controller.signal,
			}),
		).rejects.toBe(cancellation);
		expect(generate).toHaveBeenCalledTimes(2);
	});

	it("allows more than 100 resolved sections without an added cap", async () => {
		const schema: ExtractionSchemaEnvelope = {
			record: { entries: [{ id: "" }] },
			_schema_metadata: {},
		};
		const boundaryResult = {
			records: Array.from({ length: 101 }, (_, index) => ({
				record_id: String(index),
				start_index: index,
			})),
		};
		const generate = vi.fn().mockImplementation(async () => {
			if (generate.mock.calls.length === 1) return boundaryResult;
			return { id: String(generate.mock.calls.length) };
		});

		const extraction = await extractCatalog({
			document: "x".repeat(101),
			schema,
			generate,
		});

		expect(extraction.result.entries).toHaveLength(101);
		expect(generate).toHaveBeenCalledTimes(102);
	});

	it("falls back once to the whole document when no marker resolves", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce({ records: [{ start_marker: "# Missing" }] })
			.mockResolvedValueOnce(records[0]);

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});

		expect(extraction.warnings).toEqual(["boundary_fallback"]);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(generate.mock.calls[1]?.[0].document).toBe(markdown);
	});

	it("retries a suspicious section once and keeps source order", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce(boundaries)
			.mockResolvedValueOnce(records[0])
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce(records[1]);

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});
		const entries = extraction.result.entries as Array<Record<string, unknown>>;

		expect(generate).toHaveBeenCalledTimes(4);
		expect(entries.map((entry) => entry.Grav_id)).toEqual(["8", "13"]);
		expect(extraction.warnings).toEqual([]);
	});

	it("retries duplicate fingerprints once", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce(boundaries)
			.mockResolvedValueOnce(records[0])
			.mockResolvedValueOnce(records[0])
			.mockResolvedValueOnce(records[1]);

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});

		expect(generate).toHaveBeenCalledTimes(4);
		expect(
			(extraction.result.entries as Array<Record<string, unknown>>).map(
				(entry) => entry.Grav_id,
			),
		).toEqual(["8", "13"]);
	});

	it("retries an empty nested object-array when the section has table rows", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "8", start_marker: "# Grav 8", end_marker: "" }],
			})
			.mockResolvedValueOnce({ Grav_id: "8", fundliste: [] })
			.mockResolvedValueOnce(records[0]);

		const twoRowTable = markdown.replace(
			"| 8-2 | Jernspænde |",
			"| 8-2 | Jernspænde |\n| 8-3 | Kniv |",
		);
		const extraction = await extractCatalog({
			document: twoRowTable,
			schema: burial,
			generate,
		});

		expect(generate).toHaveBeenCalledTimes(3);
		const entries = extraction.result.entries as Array<Record<string, unknown>>;
		expect(entries[0]?.fundliste).toEqual([
			expect.objectContaining({
				Fund_no: "8-2",
				Fund_beskrivelse: "Jernspænde",
			}),
		]);
	});

	it("uses Python container truthiness when deciding whether nested objects are empty", async () => {
		const schema: ExtractionSchemaEnvelope = {
			record: { items: [{ id: "", details: { rows: [] } }] },
			_schema_metadata: {
				"record.items": { instance_description: "Each heading is one item." },
			},
		};
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "1", start_marker: "# Item", end_marker: "" }],
			})
			.mockResolvedValueOnce({ id: "", details: { rows: [] } })
			.mockResolvedValueOnce({ id: "1", details: { rows: [] } });

		await extractCatalog({ document: "# Item", schema, generate });

		expect(generate).toHaveBeenCalledTimes(3);
	});

	it("does not retry a suspicious section more than once", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "8", start_marker: "# Grav 8", end_marker: "" }],
			})
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({});

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});

		expect(generate).toHaveBeenCalledTimes(3);
		expect(extraction.result.entries).toEqual([
			expect.objectContaining({ Grav_id: null, fundliste: [] }),
		]);
	});

	it("retries one thrown record call and retains the conformed empty record if retry fails", async () => {
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "8", start_marker: "# Grav 8", end_marker: "" }],
			})
			.mockRejectedValueOnce(new Error("first failure"))
			.mockRejectedValueOnce(new Error("retry failure"));

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});

		expect(generate).toHaveBeenCalledTimes(3);
		expect(extraction.result.entries).toEqual([
			expect.objectContaining({ Grav_id: null, fundliste: [] }),
		]);
	});

	it("grounds omitted text Evidence snippets from the value in each section", async () => {
		// Faithful capture of a live NuExtract run: the second record extracts the
		// value but returns empty Grav_id snippets, while the first grounds itself.
		const modelOutputs = fixture<Record<string, unknown>[]>(
			"catalog-model-missing-evidence.json",
		);
		const generate = vi
			.fn()
			.mockResolvedValueOnce(boundaries)
			.mockResolvedValueOnce(modelOutputs[0])
			.mockResolvedValueOnce(modelOutputs[1]);

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});
		const entries = extraction.result.entries as Array<Record<string, unknown>>;
		const gravSnippets = (entry: Record<string, unknown> | undefined): unknown =>
			(
				(entry?._evidence as Record<string, unknown> | undefined)
					?.Grav_id as Record<string, unknown> | undefined
			)?.snippets;

		// Record with an omitted snippet is grounded to verbatim section text.
		expect(gravSnippets(entries[1])).toEqual(["# Grav 13"]);
		// A model snippet already verbatim in its section is left untouched.
		expect(gravSnippets(entries[0])).toEqual(["# Grav 8"]);
		for (const entry of entries) {
			const snippets = gravSnippets(entry) as string[];
			expect(snippets.every((snippet) => markdown.includes(snippet))).toBe(true);
		}
	});

	it("leaves snippets empty when the extracted value is absent from its section", async () => {
		// A hallucinated or metadata-leaked value (e.g. the "Grav 17" example) is
		// not in the section, so grounding must not fabricate Evidence for it.
		const generate = vi
			.fn()
			.mockResolvedValueOnce({
				records: [{ record_id: "8", start_marker: "# Grav 8", end_marker: "" }],
			})
			.mockResolvedValueOnce({
				Grav_id: "17",
				Ark_no: "24",
				_evidence: { Grav_id: { snippets: [] } },
				fundliste: [
					{ Fund_no: "99-9", _evidence: { Fund_no: { snippets: [] } } },
				],
			});

		const extraction = await extractCatalog({
			document: markdown,
			schema: burial,
			generate,
		});
		const entry = (extraction.result.entries as Array<Record<string, unknown>>)[0];
		const snippets = (
			(entry?._evidence as Record<string, unknown>).Grav_id as Record<
				string,
				unknown
			>
		).snippets;
		expect(snippets).toEqual([]);
	});
});
