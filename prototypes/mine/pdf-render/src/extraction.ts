// Extraction state for the read-only results viewer. The `/extract` contract
// guarantees `result` is a JSON object (decodeExtractDone rejects non-objects,
// and the backend's structured mode raises rather than returning one), so the
// viewer renders it directly with JSON.stringify.

export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running'; raw: string }
  | { status: 'ready'; result: unknown }
  | { status: 'error'; message: string }
