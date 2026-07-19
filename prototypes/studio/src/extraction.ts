export type ExtractionState =
	| { status: "idle" }
	| { status: "running" }
	| {
			status: "ready";
			result: Record<string, unknown>;
			warnings: readonly string[];
	  }
	| { status: "error"; message: string };
