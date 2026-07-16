import { useEffect, useRef, useState } from "react";
import { requestExtraction, type ExtractionStrategy } from "./api";
import type { ExtractionState } from "./extraction";

type UseExtractionOptions = {
	taskId: string | null;
	template: unknown;
	schemaReady: boolean;
	indexing: boolean;
	onComplete: (isRerun: boolean) => void;
	onError: (message: string) => void;
};

export type ExtractionController = ReturnType<typeof useExtraction>;

export function useExtraction({
	taskId,
	template,
	schemaReady,
	indexing,
	onComplete,
	onError,
}: UseExtractionOptions) {
	const [snapshot, setSnapshot] = useState<{
		readonly taskId: string | null;
		readonly state: ExtractionState;
	}>({ taskId, state: { status: "idle" } });
	const [strategy, setStrategy] = useState<ExtractionStrategy>("catalog");
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);
	useEffect(() => {
		abortRef.current?.abort();
	}, [taskId]);

	const state: ExtractionState =
		snapshot.taskId === taskId ? snapshot.state : { status: "idle" };
	const setState = (next: ExtractionState) =>
		setSnapshot({ taskId, state: next });
	const hasResults = state.status === "ready";
	const canRun =
		Boolean(taskId) && schemaReady && state.status !== "running" && !indexing;

	async function runExtraction() {
		if (state.status === "running" || !taskId || !schemaReady) return;
		abortRef.current?.abort();
		const abortController = new AbortController();
		abortRef.current = abortController;
		const isRerun = state.status === "ready";
		setState({ status: "running" });

		try {
			const { result, warnings } = await requestExtraction(
				taskId,
				template,
				strategy,
				abortController.signal,
			);
			if (abortController.signal.aborted) return;
			setState({ status: "ready", result, warnings });
			onComplete(isRerun);
		} catch (error) {
			if (abortController.signal.aborted) return;
			const message =
				error instanceof Error ? error.message : "Extraction failed.";
			setState({ status: "error", message });
			onError(message);
		}
	}

	return {
		state,
		canRun,
		hasResults,
		strategy,
		setStrategy,
		runExtraction,
	};
}
