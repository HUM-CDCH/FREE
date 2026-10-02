import type { CellValue, Table } from "./table.js";

/** A claim's verifier state, as the Parsing Service accounted it. */
export type ClaimOutcome = "supported" | "unsupported" | "not_completed" | "excluded";

/**
 * One claim of an Extraction: the value extracted at `path` (inside record `record`, 0-based, when the result holds
 * several), the reviewer's decision on it, the verifier's outcome and, when supported, the Evidence anchor it cites.
 */
export interface ProvenanceClaim {
  readonly record?: number;
  readonly path: readonly (string | number)[];
  readonly extracted: unknown;
  readonly decision?: "APPROVED" | "EDITED" | "REJECTED";
  readonly reviewed?: unknown;
  readonly outcome: ClaimOutcome;
  /** For a supported claim: who linked it, the verifier or a rule (a key or structure rule, a lexical match). */
  readonly linkedBy?: "verifier" | "rule";
  readonly reasons?: readonly string[];
  readonly anchorId?: string;
  readonly page?: number;
  readonly precision?: "cell" | "segment" | "input";
  readonly verbatim?: boolean;
  readonly lexicalHits?: number;
}

/** What a workbook adds beside its Results sheet: the Extraction's identity rows and one row per claim. */
export interface ExtractionProvenance {
  readonly identity: readonly (readonly [string, CellValue])[];
  readonly claims: readonly ProvenanceClaim[];
}

export const EXTRACTION_SHEET = "Extraction";
export const EVIDENCE_SHEET = "Evidence";

const OUTCOME: Readonly<Record<ClaimOutcome, string>> = {
  supported: "Verifier-supported",
  unsupported: "Unsupported: checks finished, no evidence",
  not_completed: "Not completed",
  excluded: "Excluded by schema policy",
};
const RULE_LINKED = "Linked by rule, not verifier-checked";

/** Item and record numbers count from 1, as Studio labels them (the Review notes sheet's rule). */
export const fieldName = (path: readonly (string | number)[]): string =>
  path.map((step, index) => typeof step === "number" ? `[${step + 1}]` : index === 0 ? String(step) : `.${step}`).join("");

const cell = (value: unknown): CellValue =>
  value === undefined || value === null || typeof value === "string" || typeof value === "boolean" ? value ?? null
    : typeof value === "number" && Number.isFinite(value) ? value : JSON.stringify(value);

/** The Extraction sheet: one Item/Value row per identity entry, in the given order. */
export function buildExtractionTable(identity: ExtractionProvenance["identity"]): Table {
  return { columns: ["Item", "Value"], rows: identity.map(([item, value]) => ({ Item: item, Value: value })) };
}

const compareStep = (left: string | number, right: string | number): number =>
  typeof left === "number" && typeof right === "number" ? left - right
    : typeof left === "number" ? -1
      : typeof right === "number" ? 1
        : left < right ? -1 : left > right ? 1 : 0;

/** Result order: the record first, then each path step (item numbers numerically, field names lexicographically);
 *  a path before the paths it leads. */
function compareClaims(left: ProvenanceClaim, right: ProvenanceClaim): number {
  const record = (left.record ?? -1) - (right.record ?? -1);
  if (record !== 0) return record;
  for (let index = 0; index < Math.min(left.path.length, right.path.length); index++) {
    const step = compareStep(left.path[index]!, right.path[index]!);
    if (step !== 0) return step;
  }
  return left.path.length - right.path.length;
}

/** The Evidence sheet: one row per claim, in result order, so equal values at different paths stay apart. */
export function buildEvidenceTable(unordered: readonly ProvenanceClaim[]): Table {
  const claims = [...unordered].sort(compareClaims);
  const recorded = claims.some((claim) => claim.record !== undefined);
  return {
    columns: [...(recorded ? ["Record"] : []), "Field", "Extracted value", "Decision", "Reviewed value", "Verifier outcome", "Reasons", "Evidence anchor", "Page", "Precision", "Value printed in anchor", "Other anchors printing the value"],
    rows: claims.map((claim) => ({
      ...(recorded ? { Record: claim.record === undefined ? null : claim.record + 1 } : {}),
      Field: fieldName(claim.path),
      "Extracted value": cell(claim.extracted),
      Decision: claim.decision ?? null,
      "Reviewed value": claim.decision === "EDITED" ? cell(claim.reviewed) : null,
      "Verifier outcome": claim.outcome === "supported" && claim.linkedBy === "rule" ? RULE_LINKED : OUTCOME[claim.outcome],
      Reasons: claim.reasons?.length ? claim.reasons.join("; ") : null,
      "Evidence anchor": claim.anchorId ?? null,
      Page: claim.page ?? null,
      Precision: claim.precision ?? null,
      "Value printed in anchor": claim.verbatim ?? null,
      "Other anchors printing the value": claim.lexicalHits === undefined ? null : Math.max(0, claim.lexicalHits - 1),
    })),
  };
}
