import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { POST as extract } from "../api/extract.ts";
import {
	evaluateBurialFindExtraction,
	type BurialFindOracle,
} from "./burialFindEvaluation.ts";

const run = promisify(execFile);
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(studioRoot, "../..");
const parsingServiceRoot = resolve(
	repositoryRoot,
	"prototypes/parsing_service",
);
const caseRoot = resolve(
	repositoryRoot,
	"evaluation/cases/burial_finds_ellekilde",
);
const artifactRoot = resolve(
	repositoryRoot,
	".artifacts/evaluations/burial_finds_ellekilde",
);
const sourcePath = resolve(
	repositoryRoot,
	"examples/Beretning_Ellekilde_8_13.pdf",
);
const markdownPath = resolve(artifactRoot, "canonical.md");
const parsedPath = resolve(artifactRoot, "parsed_document.json");
const resultPath = resolve(artifactRoot, "result.json");

describe("Burial_Finds full-pipeline evaluation", () => {
	it("extracts every explicit fund-list row and grounds every value in the source document", async () => {
		const [oracle, schema, instruction, source] = await Promise.all([
			readJson<BurialFindOracle>(resolve(caseRoot, "oracle.json")),
			readJson<unknown>(resolve(caseRoot, "schema.json")),
			readFile(resolve(caseRoot, "instruction.md"), "utf8"),
			readFile(sourcePath),
		]);

		expect(createHash("sha256").update(source).digest("hex")).toBe(
			oracle.source.content_sha256,
		);
		await rm(artifactRoot, { recursive: true, force: true });
		await mkdir(artifactRoot, { recursive: true });

		await run(
			"uv",
			[
				"run",
				"--no-sync",
				"python",
				"evaluation/export_canonical_document.py",
				"--source",
				sourcePath,
				"--markdown-output",
				markdownPath,
				"--parsed-output",
				parsedPath,
			],
			{
				cwd: parsingServiceRoot,
				timeout: 10 * 60 * 1000,
				maxBuffer: 10 * 1024 * 1024,
			},
		);

		const [canonicalMarkdown, parsedDocument] = await Promise.all([
			readFile(markdownPath, "utf8"),
			readJson<Record<string, unknown>>(parsedPath),
		]);
		assertCanonicalDocument(parsedDocument, oracle, canonicalMarkdown);

		process.env.AI_MODEL =
			process.env.EVALUATION_MODEL || "hf.co/numind/NuExtract3-GGUF:Q4_K_M";
		process.env.AI_BASE_URL = process.env.EVALUATION_BASE_URL;
		process.env.AI_CONTEXT_LENGTH =
			process.env.EVALUATION_CONTEXT_LENGTH || "8192";
		process.env.AI_API_KEY = undefined;

		const form = new FormData();
		form.set("document_markdown", canonicalMarkdown);
		form.set("template", JSON.stringify(schema));
		form.set("instruction", instruction);
		form.set("temperature", "0");
		form.set("enable_thinking", "true");
		const response = await extract(
			new Request(new URL("extract", import.meta.url), {
				method: "POST",
				body: form,
			}),
		);
		const body: unknown = await response.json();
		expect(response.status, JSON.stringify(body, null, 2)).toBe(200);
		expect(isRecord(body)).toBe(true);
		if (!isRecord(body))
			throw new Error("Extraction endpoint returned a non-object body.");

		const report = evaluateBurialFindExtraction({
			result: body.result,
			evidence: body.evidence,
			oracle,
			canonicalMarkdown,
		});
		await writeFile(
			resultPath,
			`${JSON.stringify(
				{
					model: process.env.AI_MODEL,
					context_length: process.env.AI_CONTEXT_LENGTH,
					source: oracle.source,
					report,
					result: body.result,
					evidence: body.evidence,
					raw: body.raw,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		expect(
			report.pass,
			`${report.issues.join("\n")}\nFull result: ${resultPath}`,
		).toBe(true);
	});
});

async function readJson<T>(path: string): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read evaluation JSON ${path}: ${detail}`, {
			cause: error,
		});
	}
}

function assertCanonicalDocument(
	parsed: Record<string, unknown>,
	oracle: BurialFindOracle,
	markdown: string,
): void {
	expect(isRecord(parsed.document)).toBe(true);
	if (!isRecord(parsed.document))
		throw new Error("ParsedDocument.document is missing.");
	expect(parsed.document.content_sha256).toBe(oracle.source.content_sha256);
	expect(parsed.document.page_count).toBe(oracle.source.page_count);
	for (const entry of oracle.entries) {
		expect(markdown).toContain(`# Grav ${entry.Grav_id}`);
		for (const find of entry.fundliste) {
			expect(markdown).toContain(`| ${find.Fund_no} |`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
