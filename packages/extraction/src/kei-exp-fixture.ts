/** The shapes kei-exp's extraction routes really serve, in one place so that FREE's unit
 *  double and Studio's e2e fixture cannot drift from each other or from the service.
 *
 *  Derived field by field from kei-exp (branch `feat/parsing-service-readiness`):
 *  `src/kei_exp/kie/extract/run.py` `extract()` for the artifact, `stages.py` for `Call`,
 *  `Link` and `Issue`, and `api.py` `create_extraction` / `get_extraction` for the 202
 *  acknowledgement and the polling envelope. Test-only: nothing in the runtime imports it. */
import type { KeiExpArtifact, KeiExpCall, KeiExpEnvelope, KeiExpEvidence, KeiExpStatus } from './kei-exp.js'

/** `GET /api/runs/{run_id}/extractions/{id}`: the job's status, and the artifact once it is done. */
export function keiExpEnvelope(
  overrides: Partial<KeiExpEnvelope> & { status?: KeiExpStatus } = {},
): Record<string, unknown> {
  const status = overrides.status ?? 'done'
  const terminal = status === 'done' || status === 'failed' || status === 'cancelled'
  return {
    id: 'x-000000000000',
    run_id: 'run',
    status,
    created: '2026-09-22T00:00:00+00:00',
    // kei-exp sets `finished` only once terminal and `error` only when failed.
    finished: terminal ? '2026-09-22T00:00:30+00:00' : null,
    error: status === 'failed' ? 'the model server refused the request' : null,
    // The artifact lives under `result`, and only while `status` is `done`.
    result: status === 'done' ? keiExpArtifact() : null,
    ...overrides,
  }
}

/** `POST /api/runs/{run_id}/extract`: 202 once the extraction and its job are committed. */
export function keiExpAccepted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'x-000000000000', run_id: 'run', status: 'queued', generation: 'g1', ...overrides }
}

export function keiExpArtifact(overrides: Partial<KeiExpArtifact> = {}): KeiExpArtifact {
  return {
    extraction_version: 1,
    run_id: 'run',
    // The parse manifest's generation is a minted string, not a counter (kei-exp `pagefile.Result`).
    generation: 'g1',
    digest: 'digest',
    fingerprint: 'fingerprint',
    strategy: 'article',
    model: 'kei-exp-default',
    // kei-exp's `PROMPT_VERSION`: a number.
    prompt_version: 1,
    schema: { recordDescription: 'Article records.', schemaNodes: [] },
    options: { strategy: 'article', model: null, discovery_chars: 48_000, record_chars: 24_000 },
    started: '2026-09-22T00:00:00+00:00',
    seconds: 1.25,
    complete: false,
    records: [],
    evidence: [],
    ungrounded: [],
    // The document-level fields (`valueSource: document`): extracted into every record, never grounded.
    unverified: [],
    issues: [],
    // One object per model call, not a count.
    calls: [keiExpCall()],
    // Null when no call reported usage.
    tokens: { input: 20, output: 10 },
    ...overrides,
  }
}

export function keiExpCall(overrides: Partial<KeiExpCall> = {}): KeiExpCall {
  return {
    stage: 'record', record: 0, input_tokens: 20, output_tokens: 10,
    seconds: 0.5, finish: 'stop', ok: true, error: null, ...overrides,
  }
}

export function keiExpEvidence(overrides: Partial<KeiExpEvidence> = {}): KeiExpEvidence {
  return {
    path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: [1, 2, 3, 4],
    verbatim: true, hits: 1, linked_by: 'lexical', ...overrides,
  }
}
