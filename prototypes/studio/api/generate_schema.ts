import {
	generateSchemaWithModel,
	json,
	modelError,
	parseAnnotationMode,
	parseAnnotations,
	parseDocument,
	parseTemperature,
} from "./_model";

export async function POST(request: Request): Promise<Response> {
	try {
		const form = await request.formData();
		const result = await generateSchemaWithModel({
			document: await parseDocument(form),
			annotations: parseAnnotations(form.get("annotations")),
			annotationsMode: parseAnnotationMode(form.get("annotations_mode")),
			temperature: parseTemperature(form.get("temperature")),
		});

		return json({ suggestionId: crypto.randomUUID(), ...result });
	} catch (error) {
		return modelError(error);
	}
}
