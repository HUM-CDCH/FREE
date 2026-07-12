type BurialFind = {
	readonly Fund_no: string;
	readonly Fund_beskrivelse: string;
	readonly Fundplacering: string;
	readonly Fund_bemaerkning: string;
};

type BurialEntry = {
	readonly Grav_id: string;
	readonly Ark_no: string;
	readonly fundliste: readonly BurialFind[];
};

export type BurialFindOracle = {
	readonly source: {
		readonly filename: string;
		readonly content_sha256: string;
		readonly page_count: number;
	};
	readonly entries: readonly BurialEntry[];
};

export type BurialFindEvaluationReport = {
	readonly pass: boolean;
	readonly issues: readonly string[];
	readonly metrics: {
		readonly graves: {
			readonly expected: number;
			readonly actual: number;
			readonly matched: number;
		};
		readonly finds: {
			readonly expected: number;
			readonly actual: number;
			readonly matched: number;
		};
		readonly exactFields: {
			readonly expected: number;
			readonly matched: number;
		};
		readonly evidence: { readonly required: number; readonly grounded: number };
	};
};

type EvaluationInput = {
	readonly result: unknown;
	readonly evidence: unknown;
	readonly oracle: BurialFindOracle;
	readonly canonicalMarkdown: string;
};

type ActualEntry = BurialEntry & { readonly evidence: unknown };
type ActualFind = BurialFind & { readonly evidence: unknown };

const entryFields = ["Grav_id", "Ark_no"] as const;
const findFields = [
	"Fund_no",
	"Fund_beskrivelse",
	"Fundplacering",
	"Fund_bemaerkning",
] as const;
const exactFindFields = new Set<(typeof findFields)[number]>([
	"Fund_no",
	"Fund_beskrivelse",
	"Fund_bemaerkning",
]);

export function evaluateBurialFindExtraction({
	result,
	evidence,
	oracle,
	canonicalMarkdown,
}: EvaluationInput): BurialFindEvaluationReport {
	const issues: string[] = [];
	const actualEntries = readEntries(result, evidence, issues);
	const actualByGrave = uniqueBy(
		actualEntries,
		(entry) => entry.Grav_id,
		"grave",
		issues,
	);
	const expectedByGrave = new Map(
		oracle.entries.map((entry) => [entry.Grav_id, entry]),
	);
	let matchedGraves = 0;
	let expectedFields = 0;
	let matchedFields = 0;
	let requiredEvidence = 0;
	let groundedEvidence = 0;
	let expectedFinds = 0;
	let actualFinds = 0;
	let matchedFinds = 0;

	for (const graveId of actualByGrave.keys()) {
		if (!expectedByGrave.has(graveId)) {
			issues.push(`Unexpected grave ${graveId || "<empty>"}.`);
		}
	}

	for (const expectedEntry of oracle.entries) {
		expectedFinds += expectedEntry.fundliste.length;
		const actualEntry = actualByGrave.get(expectedEntry.Grav_id);
		if (!actualEntry) {
			issues.push(`Missing grave ${expectedEntry.Grav_id}.`);
			expectedFields +=
				entryFields.length +
				expectedEntry.fundliste.length * exactFindFields.size;
			continue;
		}

		matchedGraves += 1;
		for (const field of entryFields) {
			expectedFields += 1;
			if (sameText(actualEntry[field], expectedEntry[field])) {
				matchedFields += 1;
			} else {
				issues.push(
					fieldMismatch(
						`grave ${expectedEntry.Grav_id}`,
						field,
						expectedEntry[field],
						actualEntry[field],
					),
				);
			}
			const grounded = checkEvidence({
				evidenceNode: actualEntry.evidence,
				field,
				value: actualEntry[field],
				canonicalMarkdown,
				pageCount: oracle.source.page_count,
				label: `grave ${expectedEntry.Grav_id}.${field}`,
				issues,
			});
			if (actualEntry[field].trim()) {
				requiredEvidence += 1;
				groundedEvidence += Number(grounded);
			}
		}

		actualFinds += actualEntry.fundliste.length;
		const actualFindsWithEvidence =
			actualEntry.fundliste as readonly ActualFind[];
		const actualByFind = uniqueBy(
			actualFindsWithEvidence,
			(find) => find.Fund_no,
			`find in grave ${expectedEntry.Grav_id}`,
			issues,
		);
		const expectedByFind = new Map(
			expectedEntry.fundliste.map((find) => [find.Fund_no, find]),
		);

		for (const findNo of actualByFind.keys()) {
			if (!expectedByFind.has(findNo)) {
				issues.push(
					`Unexpected find ${expectedEntry.Grav_id}/${findNo || "<empty>"}.`,
				);
			}
		}

		for (const expectedFind of expectedEntry.fundliste) {
			const actualFind = actualByFind.get(expectedFind.Fund_no);
			if (!actualFind) {
				issues.push(
					`Missing find ${expectedEntry.Grav_id}/${expectedFind.Fund_no}.`,
				);
				expectedFields += exactFindFields.size;
				continue;
			}
			matchedFinds += 1;
			for (const field of findFields) {
				if (exactFindFields.has(field)) {
					expectedFields += 1;
					if (sameText(actualFind[field], expectedFind[field])) {
						matchedFields += 1;
					} else {
						issues.push(
							fieldMismatch(
								`find ${expectedEntry.Grav_id}/${expectedFind.Fund_no}`,
								field,
								expectedFind[field],
								actualFind[field],
							),
						);
					}
				}
				const grounded = checkEvidence({
					evidenceNode: actualFind.evidence,
					field,
					value: actualFind[field],
					canonicalMarkdown,
					pageCount: oracle.source.page_count,
					label: `find ${expectedEntry.Grav_id}/${expectedFind.Fund_no}.${field}`,
					issues,
				});
				if (actualFind[field].trim()) {
					requiredEvidence += 1;
					groundedEvidence += Number(grounded);
				}
			}
		}
	}

	for (const actualEntry of actualEntries) {
		if (!expectedByGrave.has(actualEntry.Grav_id)) {
			actualFinds += actualEntry.fundliste.length;
		}
	}

	return {
		pass: issues.length === 0,
		issues,
		metrics: {
			graves: {
				expected: oracle.entries.length,
				actual: actualEntries.length,
				matched: matchedGraves,
			},
			finds: {
				expected: expectedFinds,
				actual: actualFinds,
				matched: matchedFinds,
			},
			exactFields: { expected: expectedFields, matched: matchedFields },
			evidence: { required: requiredEvidence, grounded: groundedEvidence },
		},
	};
}

function readEntries(
	result: unknown,
	evidence: unknown,
	issues: string[],
): ActualEntry[] {
	if (!isRecord(result) || !Array.isArray(result.entries)) {
		issues.push("Extraction result must contain an entries array.");
		return [];
	}
	const evidenceEntries =
		isRecord(evidence) && Array.isArray(evidence.entries)
			? evidence.entries
			: [];
	const entries: ActualEntry[] = [];
	result.entries.forEach((value, index) => {
		if (!isRecord(value) || !Array.isArray(value.fundliste)) {
			issues.push(
				`Entry ${index} does not match the Burial_Finds extraction schema.`,
			);
			return;
		}
		const findEvidence =
			isRecord(evidenceEntries[index]) &&
			Array.isArray(evidenceEntries[index].fundliste)
				? evidenceEntries[index].fundliste
				: [];
		const finds: ActualFind[] = [];
		value.fundliste.forEach((find, findIndex) => {
			if (!isRecord(find)) {
				issues.push(
					`Find ${index}/${findIndex} does not match the Burial_Finds extraction schema.`,
				);
				return;
			}
			finds.push({
				Fund_no: text(find.Fund_no),
				Fund_beskrivelse: text(find.Fund_beskrivelse),
				Fundplacering: text(find.Fundplacering),
				Fund_bemaerkning: text(find.Fund_bemaerkning),
				evidence: findEvidence[findIndex],
			});
		});
		entries.push({
			Grav_id: text(value.Grav_id),
			Ark_no: text(value.Ark_no),
			fundliste: finds,
			evidence: evidenceEntries[index],
		});
	});
	return entries;
}

function checkEvidence({
	evidenceNode,
	field,
	value,
	canonicalMarkdown,
	pageCount,
	label,
	issues,
}: {
	readonly evidenceNode: unknown;
	readonly field: string;
	readonly value: string;
	readonly canonicalMarkdown: string;
	readonly pageCount: number;
	readonly label: string;
	readonly issues: string[];
}): boolean {
	if (!value.trim()) return false;
	const leaf = isRecord(evidenceNode) ? evidenceNode[field] : null;
	if (
		!isRecord(leaf) ||
		typeof leaf.snippet !== "string" ||
		!leaf.snippet.trim()
	) {
		issues.push(`Missing evidence for ${label}.`);
		return false;
	}
	if (!sameText(text(leaf.value), value)) {
		issues.push(`Evidence value does not match ${label}.`);
		return false;
	}
	const page = leaf.page;
	if (
		page !== null &&
		page !== undefined &&
		(!Number.isInteger(page) || Number(page) < 1 || Number(page) > pageCount)
	) {
		issues.push(`Evidence page is outside the source document for ${label}.`);
		return false;
	}
	if (!normalize(canonicalMarkdown).includes(normalize(leaf.snippet))) {
		issues.push(
			`Evidence snippet is not present in canonical Markdown for ${label}.`,
		);
		return false;
	}
	return true;
}

function uniqueBy<T>(
	values: readonly T[],
	key: (value: T) => string,
	label: string,
	issues: string[],
): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const id = key(value);
		if (result.has(id)) issues.push(`Duplicate ${label} ${id || "<empty>"}.`);
		else result.set(id, value);
	}
	return result;
}

function fieldMismatch(
	context: string,
	field: string,
	expected: string,
	actual: string,
): string {
	return `${context}.${field} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`;
}

function sameText(left: string, right: string): boolean {
	return normalize(left) === normalize(right);
}

function normalize(value: unknown): string {
	return text(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
