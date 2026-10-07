import type { ArticleSection } from './advancedSettings'

/** The Explain guide's content: illustrations and dated study findings, never a recommendation. Ordinary local data;
 *  every number is copied from the dated development study it names. */

export type GuideTopicId = 'scope' | 'grouping' | 'selection' | 'identity' | 'format' | 'grounding' | 'policy' | 'scheduling' | 'catalog'
/** One labelled block of an illustration; `note` is its state in words (never colour alone); `mark` highlights an
 *  exact code-point range of `text`; `inactive` draws a block that is omitted, not checked or refused. */
export type FigureBlock = Readonly<{ label: string; text: string; note?: string; mark?: readonly [number, number]; inactive?: boolean }>
export type ExampleOption = Readonly<{ label: string; blocks: readonly FigureBlock[]; outcome: string; notes?: readonly string[] }>
export type EvidenceSourceId = 'r1r3r4' | 'r1catalog' | 'r2a' | 'pilot' | 'audit' | 'harvey' | 'labels' | 'overflow'
/** What the studies leave open: an effect nobody measured, or choices never studied together. */
export type EvidenceGap = Readonly<{ kind: 'Not measured' | 'Combination not studied'; text: string }>
export type GuideTopic = Readonly<{
  id: GuideTopicId
  title: string
  purpose: string
  stage: string
  example: Readonly<{ caption: string; options: readonly ExampleOption[]; notes?: readonly string[] }>
  combinations: string
  takeaway: string
  evidence: readonly Readonly<{ source: EvidenceSourceId; finding: string }>[]
  gaps: readonly EvidenceGap[]
  technical: string
}>

export const SECTION_TOPIC: Readonly<Record<ArticleSection | 'generic' | 'recipe' | 'unified', GuideTopicId>> = {
  context: 'scope', identity: 'identity', input: 'format', evidence: 'grounding', generic: 'catalog', recipe: 'catalog',
  unified: 'catalog',
}

export const EVIDENCE_SOURCES: readonly Readonly<{
  id: EvidenceSourceId; title: string; date: string; corpus: string; revision: string; evidence: string; limits: string
}>[] = [
  { id: 'r1r3r4', title: 'Completed R1/R3/R4 development cells', date: '2026-09-28',
    corpus: 'Six annotated development documents per accuracy comparison (cost pairs as stated); R1 79/79, R3 12/12 and R4 4/12 cells',
    revision: 'Frozen historical runtimes, schemas and canonical parses (R1 and R3 protocol v11; R4 protocol v12)',
    evidence: 'Exact replay of completed fresh-generation cells',
    limits: 'Each comparison changes one choice from its control arm; one repetition per arm; bracketed ranges are descriptive document-bootstrap intervals; development corpus, not a prediction for today’s runtime; semantic adjudication outstanding' },
  { id: 'r1catalog', title: 'Completed R1 Catalog cells', date: '2026-09-28',
    corpus: 'One unannotated document', revision: 'Frozen historical R1 runtime',
    evidence: 'Exact replay of completed fresh-generation cells',
    limits: 'Operational observations, not Catalog accuracy or exhaustive recall; human adjudication unavailable' },
  { id: 'r2a', title: 'Value-unit selection (R2a)', date: '2026-09-28',
    corpus: '15 development documents, six of them annotated; 30 sealed cells',
    revision: 'Registered R2a selection replay; inventory and retained requests use fixed R1 replies',
    evidence: 'Conditional fixed-reply replay, grounding disabled; no new model calls',
    limits: 'Fixed-reply savings do not establish fresh-model speed or evidence recall; gold is not exhaustive; no held-out accuracy; human adjudication of the review queues outstanding' },
  { id: 'pilot', title: 'Grounding pilot', date: '2026-09-28',
    corpus: 'One selected development document (Zelechowska, no table cells); six cells of the registered 90-cell R5 matrix',
    revision: 'Registered R5 grounding settings with the original span labels (version 1); upstream records fixed',
    evidence: 'Fresh generation (101 calls), exactly replayed',
    limits: 'One document, not representative or held out; not a general cost saving; linked-claim counts are not semantic accuracy; identical requests varied; human adjudication unavailable' },
  { id: 'audit', title: 'Grounding pilot audit', date: '2026-09-28',
    corpus: 'The pilot’s one selected development document: 101 saved requests, 35 separately authorized fresh repeat calls and 69 reviewed claim–evidence pairs',
    revision: 'The pilot’s captured requests (span labels version 1)',
    evidence: 'Capture recheck, fresh repeats and two model reviews',
    limits: 'Model judgments, not human gold; selected divergent requests give no population disagreement rate; human adjudication outstanding' },
  { id: 'harvey', title: 'Harvey grounding micro-pilot', date: '2026-09-28',
    corpus: 'One previously inspected development document (Harvey); 12 cells, 16 selected decisions per method',
    revision: 'Frozen span-label versions 1 and 2, before version 2 was integrated',
    evidence: 'Fresh generation, exactly replayed',
    limits: 'A selected-claim development diagnostic, not full-document accuracy or generalization; two repeats; mechanical checks do not certify entailment; no semantic review of version 2' },
  { id: 'labels', title: 'Compact span labels', date: '2026-09-28',
    corpus: 'Five source documents (two development-gold, three unannotated); 3,138 saved admission probes in ten tokenizer-only cells',
    revision: 'Compact span labels, version 2',
    evidence: 'Tokenizer-only admission check with scripted NONE replies; offline replay',
    limits: 'Not a semantic-quality evaluation (no semantic review or held-out evaluation); fresh quality, output tokens and wall time for version 2 unmeasured' },
  { id: 'overflow', title: 'Singleton overflows', date: '2026-09-28',
    corpus: '15 pinned requests across eight catalogues of two unannotated documents',
    revision: 'Compact span labels, version 2', evidence: 'Tokenizer-only diagnosis; no model calls',
    limits: 'Selected diagnostic requests, not admission totals, evaluation gold or quality estimates; no semantic review' },
]

const unit = (label: string, text: string, note?: string, inactive = false): FigureBlock =>
  ({ label, text, ...(note ? { note } : {}), ...(inactive ? { inactive } : {}) })

export const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'scope', title: 'Full source or bounded source units',
    purpose: 'Choose whether each model call reads the whole Source Document or bounded units that fit a token ceiling.',
    stage: 'Source context for inventory, record values and verification.',
    example: {
      caption: 'Six labelled source blocks: one heading, one table and four paragraphs.',
      options: [
        { label: 'Full source', blocks: [unit('Unit 1', 'H1 heading · P1 · P2 · T1 table · P3 · P4', 'owns every block')],
          outcome: 'One unit holds every block; the served model’s context size is the limit.' },
        { label: 'Bounded source units', blocks: [
            unit('Unit 1', 'H1 heading · P1 · P2', 'owns these blocks'),
            unit('Unit 2', 'P2 · T1 table', 'P2 repeated as a previous passage, context only; owns T1 whole'),
            unit('Unit 3', 'P3 · P4', 'owns these blocks'),
            unit('Refused', 'An intact block larger than the ceiling', 'refused, never cut', true),
          ],
          outcome: 'Each block has one owning unit. A repeated previous passage is context, not a new record. The whole table stays in one unit.' },
      ],
    },
    combinations: 'Previous passages, supported units and structure-aware grouping need bounded source units. Every verification method works with either scope.',
    takeaway: 'Whole tables stay intact; repeated context is not a new record; a too-large block is refused. Diagram is illustrative, not live tokenizer output.',
    evidence: [
      { source: 'r1r3r4', finding: 'Against the full-source arm with declared identity and schema-driven instructions, bounded context changed mean accuracy by −33.35 percentage points [−49.06, −16.40]; mean calls rose by 25.47 per document (15 pairs) and mean input tokens by 115,340 (14 measurable pairs).' },
      { source: 'r1r3r4', finding: 'One preceding passage on bounded context changed mean accuracy by +3.55 [−3.79, +14.42].' },
      { source: 'overflow', finding: 'Short span labels do not make every source unit fit: single-claim span requests still exceeded a 10,240-token input allowance, so splitting claim batches cannot solve them.' },
    ],
    gaps: [{ kind: 'Not measured', text: 'Two previous passages.' }],
    technical: 'context=full|bounded; context_tokens (bounded only, at least 8,192); overlap_passages 0–2. Explicit Article runs record method_version.',
  },
  {
    id: 'grouping', title: 'Grouping',
    purpose: 'Choose how bounded units are formed: by token budget alone, or following headings, captions and tables.',
    stage: 'Bounded source units.',
    example: {
      caption: 'Heading → paragraph and caption → table → footnote.',
      options: [
        { label: 'Token budget', blocks: [unit('Unit 1', 'Heading · Paragraph · Caption'), unit('Unit 2', 'Table · Footnote')],
          outcome: 'Units fill up to the budget in source order; a caption can land apart from its table.' },
        { label: 'Structure-aware', blocks: [unit('Unit 1', 'Heading · Paragraph'), unit('Unit 2', 'Heading · Caption · Table · Footnote', 'heading repeated as context')],
          outcome: 'The caption, its table and its footnote stay together under their heading; the extra context can mean more refusals and cost.' },
      ],
    },
    combinations: 'Structure-aware grouping needs bounded source units.',
    takeaway: 'Structure adds context and can increase refusal/cost; it does not reconstruct missing tables or infer arbitrary heading hierarchies.',
    evidence: [{ source: 'r1r3r4', finding: 'R4 completed 4 of 12 cells, all of them token-grouping controls: there is no paired estimate.' }],
    gaps: [{ kind: 'Not measured', text: 'Any effect of structure-aware grouping: none of the six structural treatments has run.' }],
    technical: 'grouping=structural; token budget is the omitted default. Runs record grouping_version.',
  },
  {
    id: 'selection', title: 'Value evidence (retired)',
    purpose: 'Retired: Article now reads every source unit for values, whichever value this control holds. It stays visible read-only; a saved value is kept and sent unchanged, and choosing a starting point clears it.',
    stage: 'Record values; not inventory, document fields or verification.',
    example: {
      caption: 'Historical: One identity supported in units 1 and 4.',
      options: [
        { label: 'All source units', blocks: [unit('Unit 1', 'read for values'), unit('Unit 2', 'read for values'), unit('Unit 3', 'read for values'), unit('Unit 4', 'read for values')],
          outcome: 'Every unit is read for the record’s values.' },
        { label: 'Supported units', blocks: [unit('Unit 1', 'read for values'), unit('Unit 2', 'not read for values', 'omitted', true), unit('Unit 3', 'not read for values', 'omitted', true), unit('Unit 4', 'read for values')],
          outcome: 'Fewer value calls; a relevant value in unit 2 or 3 would not be read. Inventory and verification still visit all four units.' },
      ],
    },
    combinations: 'Retired with the other value-selection controls: Article reads every unit for values.',
    takeaway: 'Lower value-call count could omit relevant evidence; this is history, not a current choice.',
    evidence: [{ source: 'r2a', finding: 'With fixed replies, supported units changed calls by −2.13 and input tokens by −8,623 per document on average (15 documents); accuracy changed by +0.00 [+0.00, +0.00] on the six annotated documents, and a zero-width interval does not establish equivalence.' }],
    gaps: [
      { kind: 'Not measured', text: 'Fresh-model speed and evidence recall.' },
      { kind: 'Combination not studied', text: 'Supported units with any verification method: grounding was disabled in both arms.' },
    ],
    technical: 'selection=supported; all units is the omitted default. Runs record selection_version and their selections.',
  },
  {
    id: 'identity', title: 'Record identity (retired)',
    purpose: 'Retired: Article now extracts one document-level object, so there are no records to reconcile, whichever values Reconciliation and Identity fields hold. They stay visible read-only; saved values are kept and sent unchanged, and choosing a starting point resets Reconciliation.',
    stage: 'Inventory and identity.',
    example: {
      caption: 'Historical: Two records share a species but differ by preparation.',
      options: [
        { label: 'Reference', blocks: [unit('Found', 'Mus musculus · skull'), unit('Found', 'Mus musculus · skin')],
          outcome: 'The model’s own identity may merge both into one record.' },
        { label: 'Declared: species and preparation', blocks: [unit('Record 1', 'Mus musculus · skull'), unit('Record 2', 'Mus musculus · skin')],
          outcome: 'Two records: species and preparation together tell them apart.' },
        { label: 'Declared: species', blocks: [unit('Record 1', 'Mus musculus · skull + skin', 'merged')],
          outcome: 'One record: a key that is too broad merges them.' },
      ],
    },
    combinations: 'None: both controls are read-only.',
    takeaway: 'Too broad a key can merge records; missing declared keys can leave duplicates.',
    evidence: [{ source: 'r1r3r4', finding: 'Against the reference, declared identity changed mean accuracy by −0.18 [−0.53, 0.00].' }],
    gaps: [],
    technical: 'identity=reference|conservative; identity_fields are exact, case-sensitive field names.',
  },
  {
    id: 'format', title: 'Extraction input',
    purpose: 'Choose how source text is presented to the model. Instructions are retired: Article’s model requests no longer change with that choice (its saved value is kept and sent unchanged).',
    stage: 'Model input for record values and verification.',
    example: {
      caption: 'The same small 2×2 table.',
      options: [
        { label: 'Plain text', blocks: [unit('Input', 'Site Year Hill 1827', 'the cell text in reading order')],
          outcome: 'The parsed characters as they are.' },
        { label: 'Structured blocks and tables', blocks: [unit('Input', '[T1] r1c1 Site | r1c2 Year ; r2c1 Hill | r2c2 1827', 'labelled cells with row and column')],
          outcome: 'The same characters, plus labels that consume tokens.' },
      ],
    },
    combinations: 'Both representations work with every other choice; the instructions choice is retired and no longer changes Article’s requests.',
    takeaway: 'Exact input text is preserved; added markup consumes tokens.',
    evidence: [
      { source: 'r1r3r4', finding: 'On full source, structured blocks and tables changed mean accuracy by −24.12 [−49.79, −3.93]; calls fell by 1.33 and input tokens rose by 4,810 per document on average, and the refused Harvey inventory contributes to both.' },
      { source: 'r1r3r4', finding: 'Harvey’s structured inventory was refused: 28,974 input plus 4,096 reserved output tokens exceeded 32,768 by 302.' },
      { source: 'r1r3r4', finding: 'With declared identity, schema-driven instructions changed mean accuracy by −0.76 [−2.27, 0.00].' },
    ],
    gaps: [{ kind: 'Not measured', text: 'Structured blocks and tables with bounded source units: they were compared on full source only.' }],
    technical: 'prompt=reference|schema is a retired key kept for historical settings; rendering=structured (plain text is omitted). Runs record rendering_version.',
  },
  {
    id: 'grounding', title: 'Verification',
    purpose: 'Choose how each populated record value is checked against the source.',
    stage: 'Evidence verification.',
    example: {
      caption: 'Source: “ASC: 18.6 °C. PSC: 15.6 °C.” Claim: ASC temperature = 18.6.',
      options: [
        { label: 'Source labels', blocks: [unit('Passage p1_s0', 'ASC: 18.6 °C. PSC: 15.6 °C.', 'linked as a whole')],
          outcome: 'The model picks the labelled passage that supports the claim; the whole passage is linked, not an exact range.' },
        { label: 'Generated quotes', blocks: [unit('Quote', 'ASC: 18.6 °C', 'must occur verbatim in the source')],
          outcome: 'A quote that does not occur verbatim in the source is refused; whether it supports the claim is the model’s judgement.' },
        { label: 'Source span E1', blocks: [
            { label: 'Span E1 in passage p1_s0', text: 'ASC: 18.6 °C. PSC: 15.6 °C.', mark: [0, 12], note: 'exact code-point range 0–12' },
            { label: 'Span E2 in table p2_s1, cell r2_c2', text: 'Row ASC, column Td (°C): 18.6', mark: [25, 29], note: 'exact cell; its row and column headers are context' },
          ],
          outcome: 'The model chooses an offered span; that exact range or cell is linked. The exact range does not prove every part of a claim.',
          notes: ['Text range is exact. Highlight precision depends on available geometry.', 'E1 is a compact transport label, not the stored evidence ID.'] },
        { label: 'Off', blocks: [unit('Claim', 'ASC temperature = 18.6', 'not verified', true)],
          outcome: 'No verification: the value stays visibly ungrounded.' },
      ],
      notes: ['15.6 belongs to PSC: linking it to the ASC claim would be wrong-subject evidence.'],
    },
    combinations: 'Schema policies need generated quotes or source spans. Continue verification and unit order are retired: every method is routed and stops at first support.',
    takeaway: 'Exact source location alone is not proof that the entire claim is supported. Wrong-subject 15.6 must not become support.',
    evidence: [
      { source: 'pilot', finding: 'Source spans with schema policies and until first support used 10 versus 40 calls and 89,770 versus 222,156 input tokens compared with generated quotes, on one selected document.' },
      { source: 'pilot', finding: 'That arm linked 35 versus 30 of 78 claim paths; two quoted-arm links were lost, and link counts do not establish semantic accuracy.' },
      { source: 'audit', finding: 'Identical requests returned different decisions in 4 of 20 groups; two model reviews agreed on record attribution for only 43 of 69 claim–evidence pairs.' },
      { source: 'harvey', finding: 'Compact span labels admitted all 16 selected decisions that the original labels refused, but used 8 versus 4 calls and 80,806 versus 34,910 input tokens compared with generated quotes; both methods linked a compound claim the source only partly supports.' },
      { source: 'r1r3r4', finding: 'Generated quotes changed mean accuracy by −1.52 [−4.55, 0.00] on bounded context and 0.00 [0.00, 0.00] on full source; the upstream records also changed, so neither is an estimate of verifier quality.' },
      { source: 'labels', finding: 'Compact labels removed every span budget refusal for two sources in a scripted admission check; a third still refused 345 of 460 claim–unit pairs.' },
    ],
    gaps: [{ kind: 'Not measured', text: 'Semantic precision, evidence recall and unsupported-link rates: no human adjudication is available.' }],
    technical: 'grounding=semantic|quoted|spans|off. Span runs record span_grounding_version; it is metadata, not a setting.',
  },
  {
    id: 'policy', title: 'Fields to verify',
    purpose: 'Choose whether verification follows the pinned schema’s evidence policies.',
    stage: 'Which record values verification considers.',
    example: {
      caption: 'Parent notes is derived; its child temperature is quoted; its child method inherits derived.',
      options: [
        { label: 'All populated record fields', blocks: [unit('notes › temperature', 'checked'), unit('notes › method', 'checked')],
          outcome: 'Every populated record value is checked.' },
        { label: 'Follow schema policies', blocks: [unit('notes › temperature', 'checked', 'quoted: eligible'), unit('notes › method', 'kept, not checked', 'derived (inherited): skipped', true)],
          outcome: 'Only quoted values are checked; skipped values stay visibly ungrounded with their policy. Results count all and eligible values separately.' },
      ],
    },
    combinations: 'Needs generated quotes or source spans. Policies belong to the Extraction Schema; this choice never edits them.',
    takeaway: '“Quoted” means source support required, including with span grounding; derived does not compute/validate a value; skipped leaves remain ungrounded.',
    evidence: [
      { source: 'pilot', finding: 'With source spans on one selected document, schema policies used 10 versus 16 calls and 84 versus 156 claim–source decisions and kept all 35 linked paths; one selected proof changed.' },
      { source: 'pilot', finding: '36 status leaves were derived, leaving 42 of 78 claims eligible; skipped fields are not verified or presumed correct.' },
    ],
    gaps: [{ kind: 'Combination not studied', text: 'Schema policies with generated quotes.' }],
    technical: 'evidence_policy=schema. Results list each skipped path with its policy; no eligible value reads as not applicable.',
  },
  {
    id: 'scheduling', title: 'Continue verification and unit order (retired)',
    purpose: 'Retired: Article now checks every claim first in the source unit its value was read from and stops at the first support, whichever value these two controls hold. They stay visible read-only; a saved value is kept and sent unchanged. Choosing a starting point clears them.',
    stage: 'Order and extent of evidence verification (no longer a setting since ARTICLE_VERSION 6).',
    example: {
      caption: 'One claim against three units: Article now.',
      options: [
        { label: 'What Article does now', blocks: [unit('Unit 2', 'tried first: its value was read here', 'support stops here'), unit('Unit 1', 'checked only while unresolved', undefined, true), unit('Unit 3', 'checked only while unresolved', undefined, true)],
          outcome: 'NONE or a failed call does not end the search; support does. Contradictions in units never reached stay unknown.' },
      ],
    },
    combinations: 'None: both controls are read-only. The historical findings below were measured when they were live.',
    takeaway: 'First support does not settle contradictions: a value supported in one unit may be contradicted in a unit that was never checked.',
    evidence: [
      { source: 'pilot', finding: 'With source spans on one selected document, until first support used 14 versus 16 calls and 122 versus 156 claim–source decisions; its one fewer link also differed between byte-identical requests.' },
      { source: 'pilot', finding: 'Together with schema policies it reduced decisions from 84 to 49 at the same 10 calls and kept the same 35 linked paths, with two proofs changed; the interaction was not additive (+2 calls and +8,772 input tokens, one document, no interval).' },
      { source: 'pilot', finding: 'Origin and lexical order used one extra call and 4,871 extra input tokens and kept two fewer links than the unrouted combined run.' },
      { source: 'audit', finding: 'One of those losses was an identical-request difference; a five-repeat check reproduced the other for the routed request form (6/6 NONE versus 7/7 linked, originals included).' },
    ],
    gaps: [
      { kind: 'Not measured', text: 'Historical (controls retired): A general routing effect.' },
      { kind: 'Combination not studied', text: 'Historical (controls retired): Until first support or unit order with generated quotes.' },
    ],
    technical: 'grounding_schedule and grounding_routing are in RETIRED_ARTICLE_KEYS; the Parsing Service routes every claim (routing.VERSION 2) and records grounding_routing_version only when the retired key is still set.',
  },
  {
    id: 'catalog', title: 'Catalog',
    purpose: 'Generic Catalog limits apply to Model discovery; recipe budgets and factors apply to numbered-catalogue recipes. Where the deployment enables the unified Catalog, one group of five controls replaces both for every new single and batch Catalog Extraction.',
    stage: 'Catalog discovery and per-entry extraction.',
    example: {
      caption: 'Heading “Grav 7”, an abbreviated material and a neighboring line.',
      options: [
        { label: 'All factors on', blocks: [unit('Entry', 'Grav 7 · Kn. · next line')],
          outcome: 'The glossary expansion sits beside the raw value, the heading is inherited, the neighboring line is context, and values are verified.' },
        { label: 'Glossary off', blocks: [unit('Entry', 'Kn.', 'raw value only')], outcome: 'The abbreviation stays raw; glossary normalization is off too.' },
        { label: 'Inherited headings off', blocks: [unit('Entry', 'Kn.', 'no heading binding')], outcome: '“Grav 7” is not bound to the entry.' },
        { label: 'Neighboring context off', blocks: [unit('Entry', 'Grav 7 · Kn.', 'no neighboring line')], outcome: 'The neighboring line is not shown.' },
        { label: 'Verification off', blocks: [unit('Entry', 'Kn.', 'proposal')], outcome: 'Typed values are kept as proposals, not accepted evidence.' },
      ],
    },
    combinations: 'Factor switches never turn off structural ownership or canonical spans. A recipe is chosen per Extraction. In the unified Catalog, input and reply budgets change how the source is split into requests, never how much of it is read; with overlap 0 a record continues across a split only when both sides say so; retired limits and recipe factors are never converted.',
    takeaway: "Verification Off yields proposals; a recipe's applicability is source-specific.",
    evidence: [{ source: 'r1catalog', finding: 'Recipe, recipe without neighboring context and recipe without verification each made seven calls and returned seven records; without neighboring context it used 440 fewer input tokens; generic Catalog made 14 calls.' }],
    gaps: [
      { kind: 'Not measured', text: 'Catalog accuracy, exhaustive recall and any benefit of switching verification off; glossary and inherited headings were not varied.' },
      { kind: 'Not measured', text: 'The unified Catalog on independent document families; its default reserves and overlap are engineering choices, not measured settings.' },
    ],
    technical: 'discovery_chars, record_chars (generic); catalog.input_tokens, catalog.output_tokens, catalog.factors.{glossary,headings,overlap,verification} (recipe); unified.{defaults,input_tokens,output_tokens,overlap,headings,verification}, result version 3 with its execution and discovery records (unified).',
  },
]

/** How this works: the text equivalent of the one flow diagram (design §5). */
export const FLOW_TEXT =
  'Canonical Source Context feeds Context and grouping. Context and grouping feeds Inventory and identity, Record values and Evidence verification. Inventory and identity feeds Record values. Record values feeds Evidence verification. Schema policies feed Evidence verification. Evidence verification feeds Extraction Result and review.'
export const FLOW_NOTE =
  'Rendering affects model input; verification is routed to the unit each value was read from and stops at first support. Selection, scheduling and routing are retired controls kept for historical settings. The diagram is conceptual: filename and document fields and recipe Catalog have their own paths and are not Article stages.'
