import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderConfigPage from "./ProviderConfigPage";

describe("ProviderConfigPage", () => {
	it("renders the default single-model configuration", () => {
		const html = renderToStaticMarkup(<ProviderConfigPage onClose={() => {}} />);

		expect(html).toContain("Tasks currently use different models");
		expect(html).toContain('aria-label="Configuration mode"');
		expect(html).toContain('type="password"');
		expect(html).toContain('disabled="">Apply');
		expect(html).toContain("Paste your OpenAI API key to finish.");
	});
});
