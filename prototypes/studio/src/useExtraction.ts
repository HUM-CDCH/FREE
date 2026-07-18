import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	requestExtraction,
	type ExtractionSchemaEnvelope,
	type ExtractionStrategy,
} from "./api";
import type { ExtractionState } from "./extraction";

type UseExtractionOptions = {
	documentEpoch: number;
	schemaRevision: number;
	taskId: string | null;
	schema: ExtractionSchemaEnvelope | null;
	schemaReady: boolean;
	indexing: boolean;
	strategy: ExtractionStrategy;
	onStrategyChange: (strategy: ExtractionStrategy) => void;
	onComplete: (isRerun: boolean) => void;
	onError: (message: string) => void;
};

export type ExtractionIdentity = {
	readonly documentEpoch: number;
	readonly schemaRevision: number;
	readonly taskId: string | null;
	readonly schema: ExtractionSchemaEnvelope | null;
	readonly strategy: ExtractionStrategy;
};

export type ExtractionSnapshot = ExtractionIdentity & {
	readonly state: ExtractionState;
};

export function isCurrentExtractionInvocation(
	invocation: ExtractionIdentity,
	current: ExtractionIdentity,
	aborted: boolean,
): boolean {
	return (
		!aborted &&
		invocation.documentEpoch === current.documentEpoch &&
		invocation.schemaRevision === current.schemaRevision &&
		invocation.taskId === current.taskId &&
		invocation.schema === current.schema &&
		invocation.strategy === current.strategy
	);
}

export function projectExtractionState(
	snapshot: ExtractionSnapshot,
	identity: ExtractionIdentity,
): ExtractionState {
	return isCurrentExtractionInvocation(snapshot, identity, false)
		? snapshot.state
		: { status: "idle" };
}

export type ExtractionController = ReturnType<typeof useExtraction>;

export function useExtraction({
	documentEpoch,
	schemaRevision,
	taskId,
	schema,
	schemaReady,
	indexing,
	strategy,
	onStrategyChange,
	onComplete,
	onError,
}: UseExtractionOptions) {
	const identity: ExtractionIdentity = useMemo(
		() => ({ documentEpoch, schemaRevision, taskId, schema, strategy }),
		[documentEpoch, schemaRevision, taskId, schema, strategy],
	);
	const currentIdentityRef = useRef(identity);
	const [snapshot, setSnapshot] = useState<ExtractionSnapshot>({
		...identity,
		state: { status: "idle" },
	});
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);
	useLayoutEffect(() => {
		currentIdentityRef.current = identity;
		abortRef.current?.abort();
	}, [identity]);

	const state = projectExtractionState(snapshot, identity);
	const hasResults = state.status === "ready";
	const canRun =
		Boolean(taskId) &&
		Boolean(schema) &&
		schemaReady &&
		state.status !== "running" &&
		!indexing;

	async function runExtraction() {
		if (state.status === "running" || !taskId || !schema || !schemaReady)
			return;
		abortRef.current?.abort();
		const abortController = new AbortController();
		abortRef.current = abortController;
		const isRerun = state.status === "ready";
		const invocation = identity;
		setSnapshot({ ...invocation, state: { status: "running" } });

		try {
			const { result, warnings } = await requestExtraction(
				taskId,
				schema,
				strategy,
				abortController.signal,
			);
			if (
				!isCurrentExtractionInvocation(
					invocation,
					currentIdentityRef.current,
					abortController.signal.aborted,
				)
			)
				return;
			setSnapshot({
				...invocation,
				state: { status: "ready", result, warnings },
			});
			onComplete(isRerun);
		} catch (error) {
			if (
				!isCurrentExtractionInvocation(
					invocation,
					currentIdentityRef.current,
					abortController.signal.aborted,
				)
			)
				return;
			const message =
				error instanceof Error ? error.message : "Extraction failed.";
			setSnapshot({ ...invocation, state: { status: "error", message } });
			onError(message);
		}
	}

	return {
		state,
		canRun,
		hasResults,
		strategy,
		setStrategy: onStrategyChange,
		runExtraction,
	};
}
