const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUBSCRIPT_LETTERS: Record<string, string> = {
	ₐ: "a",
	ₑ: "e",
	ₒ: "o",
	ₓ: "x",
	ₘ: "m",
	ₙ: "n",
	ₕ: "h",
	ₖ: "k",
	ₗ: "l",
	ₚ: "p",
	ₛ: "s",
	ₜ: "t",
};
const DASHES = /[–—−―﹘]/g;

export function normalizePdfText(value: string): string {
	let normalized = "";
	for (const character of value.normalize("NFKD")) {
		if (/\p{Mark}/u.test(character)) continue;
		const subscript = SUBSCRIPT_DIGITS.indexOf(character);
		if (subscript >= 0) {
			normalized += String(subscript);
			continue;
		}
		const superscript = SUPERSCRIPT_DIGITS.indexOf(character);
		if (superscript >= 0) {
			normalized += String(superscript);
			continue;
		}
		normalized += SUBSCRIPT_LETTERS[character] ?? character;
	}
	return normalized
		.toLowerCase()
		.replace(DASHES, "-")
		.replace(/[^a-z0-9%-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function matchPdfTextItems(
	items: readonly string[],
	query: string,
): number[] {
	const queryTokens = tokens(query);
	if (queryTokens.length === 0) return [];
	const flattened = items.flatMap((item, itemIndex) =>
		tokens(item).map((token) => ({ token, itemIndex })),
	);

	for (let start = 0; start < flattened.length; start += 1) {
		const end = matchFrom(flattened, queryTokens, start, 0);
		if (end === null) continue;
		return [
			...new Set(flattened.slice(start, end).map(({ itemIndex }) => itemIndex)),
		];
	}
	return [];
}

function matchFrom(
	pdfTokens: readonly { readonly token: string; readonly itemIndex: number }[],
	queryTokens: readonly string[],
	pdfIndex: number,
	queryIndex: number,
): number | null {
	if (queryIndex === queryTokens.length) return pdfIndex;
	for (
		let width = 1;
		width <= 3 && pdfIndex + width <= pdfTokens.length;
		width += 1
	) {
		const candidate = pdfTokens
			.slice(pdfIndex, pdfIndex + width)
			.map(({ token }) => token)
			.join("");
		if (!tokensMatch(queryTokens[queryIndex] ?? "", candidate)) continue;
		const end = matchFrom(
			pdfTokens,
			queryTokens,
			pdfIndex + width,
			queryIndex + 1,
		);
		if (end !== null) return end;
	}
	return null;
}

function tokens(value: string): string[] {
	const normalized = normalizePdfText(value);
	return normalized ? normalized.split(" ") : [];
}

function tokensMatch(left: string, right: string): boolean {
	if (left === right) return true;
	if (hasDigitOrHyphen(left) || hasDigitOrHyphen(right)) {
		if (left.length === 2 && right.length === 2) {
			return (
				left[0] === right[0] &&
				/[a-z]/.test(left[0] ?? "") &&
				new Set([left[1], right[1]]).size === 2 &&
				[left[1], right[1]].every((value) => value === "o" || value === "0")
			);
		}
		if (left.length === 2 && right.length === 1)
			return (
				left[0] === right && /[a-z]/.test(right) && /[o0]/.test(left[1] ?? "")
			);
		if (right.length === 2 && left.length === 1)
			return (
				right[0] === left && /[a-z]/.test(left) && /[o0]/.test(right[1] ?? "")
			);
		return false;
	}
	if (
		left.length >= 2 &&
		right.length >= 2 &&
		(left.startsWith(right) || right.startsWith(left))
	) {
		const shortAlpha =
			(left.length <= 3 && /^[a-z]/.test(left)) ||
			(right.length <= 3 && /^[a-z]/.test(right));
		if (!shortAlpha) return true;
	}
	return (
		left.length >= 4 &&
		right.length >= 4 &&
		sequenceMatcherRatio(left, right) >= 0.7
	);
}

function hasDigitOrHyphen(value: string): boolean {
	return /[0-9-]/.test(value);
}

function sequenceMatcherRatio(left: string, right: string): number {
	const matches = matchingCharacters(
		left,
		right,
		0,
		left.length,
		0,
		right.length,
	);
	return (2 * matches) / (left.length + right.length);
}

function matchingCharacters(
	left: string,
	right: string,
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
): number {
	const match = longestMatch(
		left,
		right,
		leftStart,
		leftEnd,
		rightStart,
		rightEnd,
	);
	if (match.size === 0) return 0;
	return (
		match.size +
		matchingCharacters(
			left,
			right,
			leftStart,
			match.left,
			rightStart,
			match.right,
		) +
		matchingCharacters(
			left,
			right,
			match.left + match.size,
			leftEnd,
			match.right + match.size,
			rightEnd,
		)
	);
}

function longestMatch(
	left: string,
	right: string,
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
): { readonly left: number; readonly right: number; readonly size: number } {
	const rightPositions = new Map<string, number[]>();
	for (let index = rightStart; index < rightEnd; index += 1) {
		const character = right[index] ?? "";
		const positions = rightPositions.get(character) ?? [];
		positions.push(index);
		rightPositions.set(character, positions);
	}

	let bestLeft = leftStart;
	let bestRight = rightStart;
	let bestSize = 0;
	let previousLengths = new Map<number, number>();
	for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
		const lengths = new Map<number, number>();
		for (const rightIndex of rightPositions.get(left[leftIndex] ?? "") ?? []) {
			const size = (previousLengths.get(rightIndex - 1) ?? 0) + 1;
			lengths.set(rightIndex, size);
			if (size > bestSize) {
				bestLeft = leftIndex - size + 1;
				bestRight = rightIndex - size + 1;
				bestSize = size;
			}
		}
		previousLengths = lengths;
	}
	return { left: bestLeft, right: bestRight, size: bestSize };
}
