import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCatalog, type ExtractionSchemaEnvelope } from "./_catalog.js";
import { fixture } from "./_fixtures.js";
import { generateStructuredWithModel } from "./_model.js";

const runLiveSmoke = process.env.RUN_NUEXTRACT_CATALOG_SMOKE === "1";

describe.skipIf(!runLiveSmoke)("live NuExtract Catalog smoke", () => {
	it("extracts the two-record Burial fixture in source order", async () => {
		const schema = fixture<ExtractionSchemaEnvelope>(
			"../../schemas/FieldReports/Burial_Finds.json",
		);
		const document = readFileSync(
			new URL("./test-fixtures/catalog-two-records.md", import.meta.url),
			"utf8",
		);

		// Keep boundary detection deterministic here so this opt-in check isolates
		// live NuExtract record generation; boundary parity is covered by pure tests.
		const deterministicBoundaries = fixture<Record<string, unknown>>(
			"catalog-boundaries.json",
		);
		let boundaryPending = true;
		const extraction = await extractCatalog({
			document,
			schema,
			generate: async (input) => {
				if (boundaryPending) {
					boundaryPending = false;
					return deterministicBoundaries;
				}
				return generateStructuredWithModel(input);
			},
		});
		const entries = extraction.result.entries as Array<Record<string, unknown>>;

		expect(entries.map((entry) => entry.Grav_id)).toEqual(["8", "13"]);
		expect(entries.some((entry) => entry.Grav_id === "17")).toBe(false);
		expect(JSON.stringify(schema._schema_metadata)).toContain("Grav 17");
		expect(
			entries.every((entry) => {
				const localEvidence = entry._evidence;
				if (
					typeof localEvidence !== "object" ||
					localEvidence === null ||
					Array.isArray(localEvidence) ||
					!("Grav_id" in localEvidence)
				) {
					return false;
				}
				const fieldEvidence = localEvidence.Grav_id;
				if (
					typeof fieldEvidence !== "object" ||
					fieldEvidence === null ||
					Array.isArray(fieldEvidence) ||
					!("snippets" in fieldEvidence)
				) {
					return false;
				}
				return (
					Array.isArray(fieldEvidence.snippets) &&
					fieldEvidence.snippets.some(
						(snippet: unknown) =>
							typeof snippet === "string" &&
							snippet.trim() !== "" &&
							document.includes(snippet),
					)
				);
			}),
		).toBe(true);
	}, 300_000);
});
