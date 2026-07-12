type GroundedNode = {
	readonly result: unknown;
	readonly evidence: unknown;
};

/** Attach evidence only when the extracted value occurs verbatim in source text. */
export function groundExtractionResult(
	result: Record<string, unknown>,
	sourceText: string,
): {
	readonly result: Record<string, unknown>;
	readonly evidence: Record<string, unknown> | null;
} {
	const grounded = groundNode(result, sourceText);
	return {
		result: grounded.result as Record<string, unknown>,
		evidence: isRecord(grounded.evidence) ? grounded.evidence : null,
	};
}

function groundNode(
	node: unknown,
	sourceText: string,
	context: readonly string[] = [],
): GroundedNode {
	if (Array.isArray(node)) {
		const grounded = node.map((item) => groundNode(item, sourceText));
		const evidence = grounded.map((item) => item.evidence);
		return {
			result: grounded.map((item) => item.result),
			evidence: evidence.some((item) => item !== null) ? evidence : null,
		};
	}

	if (isRecord(node)) {
		const result: Record<string, unknown> = {};
		const evidence: Record<string, unknown> = {};
		const siblingValues = Object.values(node).map(scalarText).filter(Boolean);
		for (const [key, value] of Object.entries(node)) {
			const grounded = groundNode(value, sourceText, siblingValues);
			result[key] = grounded.result;
			if (grounded.evidence !== null) evidence[key] = grounded.evidence;
		}
		return {
			result,
			evidence: Object.keys(evidence).length > 0 ? evidence : null,
		};
	}

	const value = scalarText(node);
	if (!value) return { result: node, evidence: null };
	const snippet = bestEvidenceLine(sourceText, value, context);
	return {
		result: snippet ? node : null,
		evidence: snippet ? { value: node, snippet, page: null } : null,
	};
}

function bestEvidenceLine(
	sourceText: string,
	value: string,
	context: readonly string[],
): string | undefined {
	let best: { readonly line: string; readonly score: number } | undefined;
	for (const line of sourceText.split(/\r?\n/)) {
		if (!line.includes(value)) continue;
		const score = context.filter((candidate) =>
			line.includes(candidate),
		).length;
		if (!best || score > best.score) best = { line: line.trim(), score };
	}
	return best?.line;
}

function scalarText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
