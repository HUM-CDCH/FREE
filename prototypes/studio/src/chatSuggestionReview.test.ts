import { describe, expect, it } from "vitest";
import { recordSuggestionReview } from "./chatSuggestionReview";

describe("chat suggestion review", () => {
	it("makes a rejected streamed suggestion non-actionable", () => {
		const rejected = recordSuggestionReview({}, "call-8", "rejected");

		expect(rejected).toEqual({ "call-8": "rejected" });
		expect(recordSuggestionReview(rejected, "call-8", "applied")).toBe(
			rejected,
		);
	});
});
