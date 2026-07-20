import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderConfigPage from "./ProviderConfigPage";

describe("ProviderConfigPage", () => {
	it("renders seeded connections and task routes", () => {
		const html = renderToStaticMarkup(<ProviderConfigPage onClose={() => {}} />);

		expect(html).toContain("Local Ollama");
		expect(html).toContain("OpenAI (lab key)");
		expect(html).toContain("Connected");
		expect(html).toContain("Mixed · ready");
		expect(html).toContain("Extraction &amp; Schema Suggestion");
		expect(html).toContain("Chat &amp; Extraction Schema editing");
		expect(html).toContain("NuExtract 2.0");
		expect(html).toContain("GPT-4o");
	});
});
