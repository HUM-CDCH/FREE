/// <reference types="node" />
import process from "node:process";
import {
	createSchemaChatProbeResponse,
	GEMMA_SCHEMA_TOOL_MODELS,
} from "../api/_schema_chat_probe.ts";

const models = process.argv.slice(2);
const candidates = models.length > 0 ? models : [...GEMMA_SCHEMA_TOOL_MODELS];

for (const model of candidates) {
	process.env.AI_CHAT_PROVIDER = "ollama";
	process.env.AI_CHAT_MODEL = model;
	const response = await createSchemaChatProbeResponse([
		{
			id: `probe-${model}`,
			role: "user",
			parts: [
				{
					type: "text",
					text: "Set the title field to string. Use the set operation, not add.",
				},
			],
		},
	]);
	const stream = await response.text();
	const required = [
		"tool-input-available",
		"tool-output-available",
		'"validated":true',
		'"operation":"set"',
		"finish",
	];
	const missing = required.filter((part) => !stream.includes(part));
	if (!response.ok || missing.length > 0) {
		throw new Error(
			`${model}: incomplete schema-tool stream (${missing.join(", ")})`,
		);
	}
	process.stdout.write(
		`${model}: input validated; output validated; UI tool parts streamed; completed\n`,
	);
}
