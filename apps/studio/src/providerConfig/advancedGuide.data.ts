import type { ArticleSection } from './advancedSettings'

/** The Explain guide's content: illustrations and dated study findings, never a recommendation. Ordinary local data;
 *  every number is copied from the dated development study it names. */

export type GuideTopicId = 'scope' | 'grouping' | 'format' | 'grounding' | 'policy' | 'catalog'
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

export const SECTION_TOPIC: Readonly<Record<ArticleSection | 'unified', GuideTopicId>> = {
  context: 'scope', input: 'format', evidence: 'grounding',
  unified: 'catalog',
}

export const EVIDENCE_SOURCES: readonly Readonly<{
  id: EvidenceSourceId; title: string; date: string; corpus: string; revision: string; evidence: string; limits: string
}>[] = [
  { id: 'r1r3r4', title: 'Completed R1/R3/R4 development cells', date: '2026-09-28',
    corpus: 'Six annotated development documents per accuracy comparison (cost pairs as stated); R1 79/79, R3 12/12 and R4 4/12 cells',
    revision: 'Frozen historical runtimes, templates and canonical parses (R1 and R3 protocol v11; R4 protocol v12)',
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
    stage: 'Source context for record values and verification.',
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
    id: 'format', title: 'Extraction input',
    purpose: 'Choose how source text is presented to the model.',
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
    combinations: 'Both representations work with every live choice. They preserve the same source text.',
    takeaway: 'Exact input text is preserved; added markup consumes tokens.',
    evidence: [
      { source: 'r1r3r4', finding: 'On full source, structured blocks and tables changed mean accuracy by −24.12 [−49.79, −3.93]; calls fell by 1.33 and input tokens rose by 4,810 per document on average, and the refused Harvey inventory contributes to both.' },
      { source: 'r1r3r4', finding: 'Harvey’s structured inventory was refused: 28,974 input plus 4,096 reserved output tokens exceeded 32,768 by 302.' },
      { source: 'r1r3r4', finding: 'With declared identity, schema-driven instructions changed mean accuracy by −0.76 [−2.27, 0.00].' },
    ],
    gaps: [{ kind: 'Not measured', text: 'Structured blocks and tables with bounded source units: they were compared on full source only.' }],
    technical: 'rendering=structured (plain text is omitted). Bounded source sizing counts the document-value request. Runs record rendering_version.',
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
    combinations: 'Template policies need generated quotes or source spans. Continue verification and unit order are retired: every method is routed and stops at first support.',
    takeaway: 'Exact source location alone is not proof that the entire claim is supported. Wrong-subject 15.6 must not become support.',
    evidence: [
      { source: 'pilot', finding: 'Source spans with template policies and until first support used 10 versus 40 calls and 89,770 versus 222,156 input tokens compared with generated quotes, on one selected document.' },
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
    purpose: 'Choose whether verification follows the pinned template’s evidence policies.',
    stage: 'Which record values verification considers.',
    example: {
      caption: 'Parent notes is derived; its child temperature is quoted; its child method inherits derived.',
      options: [
        { label: 'All populated record fields', blocks: [unit('notes › temperature', 'checked'), unit('notes › method', 'checked')],
          outcome: 'Every populated record value is checked.' },
        { label: 'Follow template policies', blocks: [unit('notes › temperature', 'checked', 'quoted: eligible'), unit('notes › method', 'kept, not checked', 'derived (inherited): skipped', true)],
          outcome: 'Only quoted values are checked; skipped values stay visibly ungrounded with their policy. Results count all and eligible values separately.' },
      ],
    },
    combinations: 'Needs generated quotes or source spans. Policies belong to the Extraction Template; this choice never edits them.',
    takeaway: '“Quoted” means source support required, including with span grounding; derived does not compute/validate a value; skipped leaves remain ungrounded.',
    evidence: [
      { source: 'pilot', finding: 'With source spans on one selected document, template policies used 10 versus 16 calls and 84 versus 156 claim–source decisions and kept all 35 linked paths; one selected proof changed.' },
      { source: 'pilot', finding: '36 status leaves were derived, leaving 42 of 78 claims eligible; skipped fields are not verified or presumed correct.' },
    ],
    gaps: [{ kind: 'Combination not studied', text: 'Template policies with generated quotes.' }],
    technical: 'evidence_policy=schema. Results list each skipped path with its policy; no eligible value reads as not applicable.',
  },

  {
    id: 'catalog', title: 'Catalog',
    purpose: 'One group of controls applies to every single and batch Catalog Extraction.',
    stage: 'Catalog discovery and per-entry extraction.',
    example: {
      caption: 'Entry 7: a bronze pin under the heading River sites.',
      options: [
        { label: 'Default single pass', blocks: [unit('Entry', '7. Bronze pin', 'quote located')],
          outcome: 'Code locates the quote and links the value by rule. A value without a locatable quote stays for review.' },
        { label: 'Heading context off', blocks: [unit('Entry', '7. Bronze pin', 'entry text only')],
          outcome: 'Heading excerpts are not offered as context; the record still keeps its owned source text.' },
        { label: 'Smaller input ceiling', blocks: [unit('Window 1', '7. Bronze pin'), unit('Window 2', 'continued source')],
          outcome: 'More requests read the same admitted source. Text is split rather than clipped.' },
      ],
    },
    combinations: 'In Catalog, input and reply budgets change how the source is split into requests, never how much of it is read; with overlap 0 a record continues across a split only when both sides say so; each value is read once: a value code locates in its own entry is linked by rule, unverified, and one without a locatable quote stays for review; a value inherited from a shared heading is accepted only when an independent reading agrees.',
    takeaway: "Catalog reads each value once. Values without locatable quotes stay for review.",
    evidence: [{ source: 'r1catalog', finding: 'An earlier study compared the retired recipe and generic Catalog methods. Those counts do not measure the current unified Catalog.' }],
    gaps: [
      { kind: 'Not measured', text: 'Current Catalog accuracy and exhaustive recall on independent documents.' },
      { kind: 'Not measured', text: 'The unified Catalog on independent document families; its default reserves and overlap are engineering choices, not measured settings.' },
    ],
    technical: 'unified.{defaults,input_tokens,output_tokens,overlap,candidates,headings}, result version 3 with its execution and discovery records (unified).',
  },
]

/** How this works: the text equivalent of the one flow diagram (design §5). */
export const FLOW_TEXT =
  'Canonical Source Context feeds Context and grouping. Context and grouping feeds Record values and Evidence verification. Record values feeds Evidence verification. Template policies feed Evidence verification. Evidence verification feeds Extraction Result and review.'
export const FLOW_NOTE =
  'Rendering affects model input; verification is routed to the unit each value was read from and stops at first support. The diagram is conceptual: filename and document fields and recipe Catalog have their own paths and are not Article stages.'
