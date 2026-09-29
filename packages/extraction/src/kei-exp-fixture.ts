/** The artifact kei-exp publishes for an Extraction, in one place so that FREE's unit doubles, the kei stand-in and
 *  Studio's e2e fixture cannot drift from each other or from the service.
 *
 *  Derived field by field from kei-exp: `src/kei_exp/kie/extract/run.py` `extract()` for the artifact, `calls.py`
 *  for `Call` and `stages.py` for `Link` and `Issue`. Test-only: nothing in the runtime imports it. */
import type { KeiExpArtifact, KeiExpCall, KeiExpEvidence, KeiExpGroundedArtifact } from './kei-exp.js'

export function keiExpArtifact(overrides: Partial<KeiExpArtifact> = {}): KeiExpArtifact {
  const model = overrides.model ?? 'kei-exp-default'
  return {
    extraction_version: 1,
    run_id: 'run',
    // The parse manifest's generation is a minted string, not a counter (kei-exp `pagefile.Result`).
    generation: 'g1',
    digest: 'digest',
    fingerprint: 'fingerprint',
    strategy: 'article',
    // The fields model's repo id, which attribution names; `models` is the repo id each role ran on.
    model,
    models: { fields: model, reasoning: model },
    // kei-exp's `PROMPT_VERSION`: a number.
    prompt_version: 1,
    schema: { recordDescription: 'Article records.', schemaNodes: [] },
    // As kei-exp dumps them: `models` is the run's choice of registry keys per role, null for the deployment defaults.
    options: { strategy: 'article', model: null, models: null, discovery_chars: 48_000, record_chars: 24_000 },
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

/** A version 2 artifact of the recipe path (`kie/extract/grounded.py`): span evidence with provenance, the proposals
 *  and rejections kept for review, competitors, the segmentation's coverage and the separated completeness. */
export function keiExpGroundedArtifact(overrides: Partial<KeiExpGroundedArtifact> = {}): KeiExpGroundedArtifact {
  const model = overrides.model ?? 'kei-exp-default'
  return {
    extraction_version: 2,
    run_id: 'run', generation: 'g1', digest: 'digest', fingerprint: 'fingerprint', strategy: 'catalog',
    model, models: { fields: model, reasoning: model }, prompt_version: 2,
    schema: { recordDescription: 'Catalogue entries.', schemaNodes: [] },
    options: { strategy: 'catalog', model: null, models: null, discovery_chars: 48_000, record_chars: 24_000,
               catalog: { recipe: 'numbered-catalogue-de@1', input_tokens: 4096, output_tokens: 1024 } },
    started: '2026-09-23T00:00:00+00:00', seconds: 2.5, complete: false,
    segmentation: {
      fingerprint: 'segmentation', digest: 'segmentation-digest',
      recipe: { id: 'numbered-catalogue-de', version: 1, structure_sha256: 's'.repeat(64), bindings_sha256: 'b'.repeat(64) },
      bindings: { entry_no: 'entry_label', kreis: 'kreis' }, bindings_unmatched: [],
      diagnostics: [{ code: 'numbering_gap', detail: 'entries 29 and 31 are 2 apart', block: 'b1',
                      spans: [{ segment: 'p1_s2', start: 0, end: 3 }] }],
    },
    budget: { version: 1, input_tokens: 4096, output_tokens: 1024,
              tokenizer: { source: 'vllm:/tokenize', model: 'Qwen/Qwen3.8-27B-FP8', model_digest: null, template_tokens: null },
              // One identity per role, since the roles may be served apart; `tokenizer` is the fields role's.
              tokenizers: {
                fields: { source: 'vllm:/tokenize', model: 'Qwen/Qwen3.8-27B-FP8', model_digest: null, template_tokens: null },
                reasoning: { source: 'vllm:/tokenize', model: 'Qwen/Qwen3.8-27B-FP8', model_digest: null, template_tokens: null },
              } },
    records: [{ entry_no: 31, kreis: 'Heide', mbl_old: 1827, site_name: null }],
    normalization: { version: 1, rules: ['glossary'] },
    record_blocks: [{ block: 'b1', entry_label: '31' }],
    evidence: [
      { path: ['records', 0, 'entry_no'], segment: 'p1_s2', page: 1, bbox_pt: [1, 2, 3, 4], verbatim: true, hits: 1,
        linked_by: 'structure', spans: [{ segment: 'p1_s2', start: 0, end: 2 }], alternatives: [],
        provenance: 'positional', key_spans: [], heading: null, precision: 'segment', raw: '31', normalized: null },
      { path: ['records', 0, 'kreis'], segment: 'p1_s1', page: 1, bbox_pt: [1, 2, 3, 4], verbatim: true, hits: 1,
        linked_by: 'structure', spans: [{ segment: 'p1_s1', start: 6, end: 11 }], alternatives: [],
        provenance: 'inherited', key_spans: [], heading: 'h2', precision: 'segment', raw: 'Heide', normalized: null },
      { path: ['records', 0, 'mbl_old'], segment: 'p1_s2', page: 1, bbox_pt: [1, 2, 3, 4], verbatim: true, hits: 1,
        linked_by: 'key', spans: [{ segment: 'p1_s2', start: 28, end: 32 }], alternatives: [],
        provenance: 'token', key_spans: [{ segment: 'p1_s2', start: 23, end: 27 }], heading: null,
        precision: 'segment', raw: '1827', normalized: null },
    ],
    proposed: [{ path: ['records', 0, 'site_name'], value: 'Eichdorf', quote: 'Eichdorf', key: null,
                 provenance: 'positional', spans: [{ segment: 'p1_s2', start: 4, end: 12 }], alternatives: [], window: 0,
                 raw: 'Eichdorf' }],
    rejected: [{ path: ['records', 0, 'fundart'], value: 'Siedl.', quote: 'FA: Siedl.', key: 'FA:',
                 provenance: 'token', spans: [], alternatives: [], window: 0, reason: 'quote_not_in_entry' }],
    competitors: [],
    ungrounded: [], unverified: [],
    coverage: { complete: false, lines: 12, entries: 1, unresolved: 1, roles: { entry: 3, unresolved: 1 },
                excluded: {}, potential_duplicates: 0, reading_order_issues: 0, withheld_intentional: [],
                withheld_failures: [] },
    completeness: { processing: true, coverage: false, grounding: true, recall: 'unmeasured' },
    issues: [], calls: [keiExpCall({ stage: 'entry' })], tokens: { input: 300, output: 60 },
    ...overrides,
  }
}
