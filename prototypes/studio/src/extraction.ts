export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; result: unknown; evidence: unknown }
  | { status: 'error'; message: string }
