export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; result: unknown }
  | { status: 'error'; message: string }
