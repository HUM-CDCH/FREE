const DEFAULT_PARSING_SERVICE = 'http://127.0.0.1:8055'
const CANCEL_TIMEOUT_MS = 5000

export function resolveParsingServiceBase(override?: string): string {
  return (
    override ??
    process.env.PARSING_SERVICE_URL ??
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
      .env?.VITE_PARSING_SERVICE_URL ??
    DEFAULT_PARSING_SERVICE
  )
}

/** Best-effort: callers have already moved on (a timed-out upload, a deleted
 * Project Context), so a failed or slow cancellation must not block them. */
export async function cancelParsingTask(
  fetcher: typeof fetch,
  base: string,
  taskId: string,
): Promise<void> {
  try {
    await fetcher(`${base.replace(/\/$/, '')}/tasks/${taskId}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    })
  } catch {
    // Ignored: the Parsing Service may reap the orphaned task on its own.
  }
}

export { DEFAULT_PARSING_SERVICE }
