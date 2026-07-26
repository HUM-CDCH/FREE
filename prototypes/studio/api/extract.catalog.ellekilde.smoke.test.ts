import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCatalog, type ExtractionSchemaEnvelope } from "./_catalog.js";
import { fixture } from "./_fixtures.js";
import { generateStructuredWithModel } from "./_model.js";

const runLiveSmoke = process.env.RUN_CATALOG_REAL_DOCUMENT_SMOKE === "1";

// Ground truth read directly off the canonical Markdown: every top-level
// "# Grav N" heading in examples/Beretning_Ellekilde_8_13.pdf, in source order.
const EXPECTED_GRAV_IDS = ["8", "13", "24", "26", "28", "30", "31"];

describe.skipIf(!runLiveSmoke)(
	"live Catalog smoke on the full Ellekilde field report",
	() => {
		it("finds every grave section and grounds Evidence for each, using whichever provider AI_PROVIDER selects", async () => {
			const schema = fixture<ExtractionSchemaEnvelope>(
				"../../schemas/FieldReports/Burial_Finds.json",
			);
			const document = readFileSync(
				new URL("./test-fixtures/ellekilde-8-13.md", import.meta.url),
				"utf8",
			);

			// No deterministic boundary override here: this test exercises the real
			// model for BOTH boundary detection and per-record extraction, since the
			// question under test is whether section-splitting itself finds every
			// grave, not just whether per-record extraction is correct once split.
			const extraction = await extractCatalog({
				document,
				schema,
				generate: generateStructuredWithModel,
			});
			const entries = extraction.result.entries as Array<Record<string, unknown>>;

			expect(extraction.warnings).toEqual([]);
			expect(entries.map((entry) => entry.Grav_id)).toEqual(EXPECTED_GRAV_IDS);

			for (const entry of entries) {
				const localEvidence = entry._evidence;
				expect(localEvidence).toBeTypeOf("object");
				const fieldEvidence = (localEvidence as Record<string, unknown>)
					.Grav_id as Record<string, unknown> | undefined;
				const snippets = fieldEvidence?.snippets;
				expect(
					Array.isArray(snippets) && snippets.length > 0,
					`entry Grav_id=${String(entry.Grav_id)} has no Grav_id evidence snippets`,
				).toBe(true);
				expect(
					(snippets as string[]).every((snippet) => document.includes(snippet)),
					`entry Grav_id=${String(entry.Grav_id)} has a fabricated (non-verbatim) snippet`,
				).toBe(true);
			}
		}, 600_000);
	},
);
