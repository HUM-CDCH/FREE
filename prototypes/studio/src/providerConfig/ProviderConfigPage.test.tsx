import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderConfigPage from "./ProviderConfigPage";

describe("ProviderConfigPage", () => {
	it("renders the default single-model configuration", () => {
		const html = renderToStaticMarkup(<ProviderConfigPage onClose={() => {}} />);

		expect(html).toContain("Tasks currently use different models");
		expect(html).toContain('aria-label="Configuration mode"');
		expect(html).not.toContain('type="password"');
		expect(html).not.toContain('disabled="">Apply');
		expect(html).toMatch(/<input placeholder="sk-\.\.\."[^>]* value=""\/>/);
		expect(html).not.toContain("sk-live");
		expect(html).toContain("Configuration changed");
	});
});
