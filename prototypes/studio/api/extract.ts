import {
	extractWithModel,
	json,
	modelError,
	parseDocument,
	parseTemperature,
	RequestError,
} from "./_model.ts";

export async function POST(request: Request): Promise<Response> {
	try {
		const form = await request.formData();
		const template = parseTemplate(form.get("template"));
		const instruction = stringValue(form.get("instruction"));
		const result = await extractWithModel({
			document: await parseDocument(form),
			template,
			instruction,
			temperature: parseTemperature(form.get("temperature")),
			enableThinking: booleanValue(form.get("enable_thinking")),
		});

		return json(result);
	} catch (error) {
		return modelError(error);
	}
}

function parseTemplate(value: FormDataEntryValue | null): unknown {
	if (value === null || value === "") {
		return {};
	}
	if (typeof value !== "string") {
		throw new RequestError(400, "template must be JSON");
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new RequestError(
			400,
			"template must be valid JSON",
			error instanceof Error ? error.message : null,
		);
	}
}

function stringValue(value: FormDataEntryValue | null): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: FormDataEntryValue | null): boolean {
	if (value === null || value === "" || value === "false") return false;
	if (value === "true") return true;
	throw new RequestError(400, "enable_thinking must be 'true' or 'false'");
}
