import { describe, expect, it } from "vitest";
import {
	INITIAL_CONNECTIONS,
	ROUTABLE_TASKS,
	type Draft,
} from "./providerConfig.data";
import {
	connectionFormState,
	routeStatus,
	routingSummary,
	type RouteEntry,
} from "./providerConfig.logic";

describe("connectionFormState", () => {
	const draft = (values: Partial<Draft> & Pick<Draft, "kind">): Draft => ({
		name: "Test",
		baseUrl: "",
		apiKey: "",
		...values,
	});

	it("derives CLI form behavior", () => {
		expect(connectionFormState(draft({ kind: "codex" }), false)).toEqual({
			showUrl: false,
			showKey: false,
			canSave: true,
			note: "Uses your local codex-cli sign-in — no URL or key needed.",
		});
	});

	it("requires a URL and shows the optional key for servers", () => {
		expect(connectionFormState(draft({ kind: "ollama" }), false)).toMatchObject({
			showUrl: true,
			showKey: true,
			canSave: false,
		});
		expect(
			connectionFormState(
				draft({ kind: "ollama", baseUrl: "http://localhost:11434" }),
				false,
			),
		).toMatchObject({ canSave: true });
	});

	it("requires an API provider and key and reveals its URL on demand", () => {
		const apiDraft = draft({ kind: "api", apiProvider: "openai" });
		expect(connectionFormState(apiDraft, false)).toMatchObject({
			showUrl: false,
			showKey: true,
			canSave: false,
		});
		expect(
			connectionFormState({ ...apiDraft, apiKey: "secret" }, true),
		).toMatchObject({ showUrl: true, canSave: true });
	});
});

describe("routeStatus", () => {
	it("distinguishes an unassigned route from a removed connection", () => {
		expect(
			routeStatus({ connectionId: null, model: null }, INITIAL_CONNECTIONS),
		).toEqual({ kind: "err", text: "Select a connection" });
		expect(
			routeStatus(
				{ connectionId: "removed", model: null },
				INITIAL_CONNECTIONS,
			),
		).toEqual({
			kind: "err",
			text: "Connection removed — pick another",
			deleted: true,
		});
	});
});

describe("routingSummary", () => {
	it("reports a mixed setup when no task has a connection", () => {
		const entries: RouteEntry[] = ROUTABLE_TASKS.map((task) => ({
			task,
			route: { connectionId: null, model: null },
			status: routeStatus(
				{ connectionId: null, model: null },
				INITIAL_CONNECTIONS,
			),
		}));

		expect(routingSummary(entries)).toMatchObject({
			overallStatus: "err",
			mixText: "Mixed setup — no connections assigned.",
		});
	});
});
