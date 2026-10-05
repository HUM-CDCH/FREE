import { createContext, type ReactNode, type RefObject, useContext, useId, useRef, useState } from 'react'
import { ARTICLE_KEYS, REFERENCE_ARTICLE, type ArticleSettings } from 'extraction/extraction-method'
import { ModalDialog } from '../ui'
import {
  EVIDENCE_SOURCES, FLOW_NOTE, FLOW_TEXT, GUIDE_TOPICS, type FigureBlock, type GuideTopic, type GuideTopicId,
} from './advancedGuide.data'
import { settingsDelta, STARTING_POINTS, withStartingPoint, type StartingPoint } from './advancedSettings'
import { SettingsViews } from './SettingsViews'

type Opened = Readonly<{ topic: GuideTopicId | 'overview'; trigger: RefObject<HTMLButtonElement | null> }>
const GuideContext = createContext<((opened: Opened) => void) | null>(null)
const actionButton = 'text-[11.5px] font-semibold text-accent hover:underline'

function useOpenGuide() {
  const open = useContext(GuideContext)
  if (!open) throw new Error('Explain needs the Advanced guide.')
  return open
}

/** The one Explain dialog for the Advanced tab. It holds no configuration: examples are local, and only "Use these
 *  settings" hands an Article draft to `onUseSettings` (the page's draft owner). */
export function GuideProvider({ article, onUseSettings, children }: {
  article: ArticleSettings | undefined
  onUseSettings: (article: ArticleSettings, name: string) => void
  children: ReactNode
}) {
  const [opened, setOpened] = useState<Opened | null>(null)
  return (
    <GuideContext value={setOpened}>
      {children}
      {opened && (
        <GuideDialog opened={opened} article={article} onTopic={(topic) => setOpened({ ...opened, topic })}
          onClose={() => setOpened(null)}
          onUse={(point) => { onUseSettings(withStartingPoint(article, point), point.name); setOpened(null) }} />
      )}
    </GuideContext>
  )
}

export function ExplainButton({ topic, subject }: { topic: GuideTopicId; subject: string }) {
  const open = useOpenGuide()
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <button ref={trigger} type="button" aria-label={`Explain ${subject}`} onClick={() => open({ topic, trigger })}
      className={actionButton}>Explain</button>
  )
}

/** `triggerRef` lets the tab return focus here, e.g. after Undo removes the control that had it. */
export function HowThisWorksButton({ triggerRef }: { triggerRef?: RefObject<HTMLButtonElement | null> }) {
  const open = useOpenGuide()
  const own = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef ?? own
  return <button ref={trigger} type="button" onClick={() => open({ topic: 'overview', trigger })} className={actionButton}>How this works</button>
}

function GuideDialog({ opened, article, onTopic, onClose, onUse }: {
  opened: Opened; article: ArticleSettings | undefined; onTopic: (topic: GuideTopicId | 'overview') => void
  onClose: () => void; onUse: (point: StartingPoint) => void
}) {
  const titleId = useId()
  const close = useRef<HTMLButtonElement>(null)
  const topic = GUIDE_TOPICS.find((item) => item.id === opened.topic)
  const topics: readonly { id: GuideTopicId | 'overview'; title: string }[] = [{ id: 'overview', title: 'How this works' }, ...GUIDE_TOPICS]
  return (
    <ModalDialog labelledBy={titleId} initialFocusRef={close} returnFocusRef={opened.trigger} onDismiss={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-visible rounded-xl border border-line bg-surface p-3 text-ink backdrop:bg-ink/35 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-[14px] font-bold text-ink">{topic ? topic.title : 'How this works'}</h2>
        <button ref={close} type="button" onClick={onClose} className="text-[11.5px] font-semibold text-ink-muted hover:text-ink">Close</button>
      </div>
      <select aria-label="Topics" value={opened.topic} onChange={(event) => onTopic(event.target.value as GuideTopicId | 'overview')}
        className="mt-2 w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[12px] text-ink">
        {topics.map((item) => (
          <option key={item.id} value={item.id}>{item.title}</option>
        ))}
      </select>
      {topic ? <TopicBody key={topic.id} topic={topic} /> : <Overview article={article} onUse={onUse} />}
    </ModalDialog>
  )
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return <h3 id={id} tabIndex={-1} className="text-[12.5px] font-semibold text-ink">{children}</h3>
}

function TopicBody({ topic }: { topic: GuideTopic }) {
  const id = useId()
  const [choice, setChoice] = useState(0)
  const option = topic.example.options[choice]!
  const part = (name: string) => `${id}-${name}`
  return (
    <div className="mt-3 flex flex-col gap-4 text-[12px] text-ink">
      <SettingsViews label="Topic section" titles={['Meaning', 'Example', 'Takeaway', 'Study evidence', 'Technical details']}>
      <section aria-labelledby={part('meaning')} className="flex flex-col gap-1">
        <Heading id={part('meaning')}>Meaning</Heading>
        <p>{topic.purpose}</p>
        <p className="text-ink-muted">Stage: {topic.stage}</p>
        <p className="text-ink-muted">Valid combinations: {topic.combinations}</p>
      </section>
      <section aria-labelledby={part('example')} className="flex flex-col gap-2">
        <Heading id={part('example')}>Example</Heading>
        <p>{topic.example.caption}</p>
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="sr-only">Show the example with</legend>
          {topic.example.options.map((item, index) => (
            <label key={item.label} className="flex items-center gap-1.5">
              <input type="radio" name={part('choice')} checked={choice === index} onChange={() => setChoice(index)} />
              {item.label}
            </label>
          ))}
        </fieldset>
        <Figure blocks={option.blocks} caption={option.outcome} />
      </section>
      <section className="flex flex-col gap-2">
        {[...(option.notes ?? []), ...(topic.example.notes ?? [])].map((note) => <p key={note} className="text-[11px] text-ink-muted">{note}</p>)}
        <p className="font-semibold">{topic.takeaway}</p>
      </section>
      <section aria-labelledby={part('evidence')} className="flex flex-col gap-2">
        <Heading id={part('evidence')}>Study evidence</Heading>
        <StudyEvidence topic={topic} />
      </section>
      <details>
        <summary className="cursor-pointer font-semibold">Technical details</summary>
        <p className="mt-1 font-mono text-[11px] break-words text-ink-muted">{topic.technical}</p>
      </details>
      </SettingsViews>
    </div>
  )
}

/** An illustration and its equivalent text: each block's label, text and state in words. */
function Figure({ blocks, caption }: { blocks: readonly FigureBlock[]; caption: string }) {
  const text = blocks.map((block) => `${block.label}: ${block.text}${block.note ? ` (${block.note})` : ''}`).join('; ')
  return (
    <figure aria-label={`${text}. ${caption}`} className="flex flex-col gap-1.5">
      <ol className="flex flex-wrap gap-2">
        {blocks.map((block, index) => (
          <li key={index} className={`min-w-0 rounded-md border px-2 py-1 ${block.inactive ? 'border-dashed border-line-strong text-ink-faint' : 'border-line bg-surface-muted'}`}>
            <span className="block text-[10.5px] font-semibold text-ink-muted">{block.label}</span>
            <Marked text={block.text} mark={block.mark} />
            {block.note && <span className="block text-[10.5px] text-ink-faint">{block.note}</span>}
          </li>
        ))}
      </ol>
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

/** `mark` is a code-point range, like span Evidence's offsets. */
function Marked({ text, mark }: { text: string; mark?: readonly [number, number] }) {
  if (!mark) return <span className="block">{text}</span>
  const points = Array.from(text)
  return (
    <span className="block">
      {points.slice(0, mark[0]).join('')}<mark className="bg-ev-soft text-ink">{points.slice(mark[0], mark[1]).join('')}</mark>{points.slice(mark[1]).join('')}
    </span>
  )
}

function StudyEvidence({ topic }: { topic: GuideTopic }) {
  const pages = topic.evidence.flatMap((row, index) => {
    const source = EVIDENCE_SOURCES.find((item) => item.id === row.source)!
    return [
      { title: `Finding ${index + 1}`, content: <div><p>{row.finding}</p><p className="mt-2 break-all text-ink-faint">{source.title} · {source.path}</p></div> },
      { title: `Study details ${index + 1}`, content: <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {Object.entries({ Date: source.date, Corpus: source.corpus, 'Method revision': source.revision, 'Evidence type': source.evidence })
          .map(([label, value]) => <div key={label} className="contents"><dt className="font-semibold text-ink-muted">{label}</dt><dd>{value}</dd></div>)}
      </dl> },
      { title: `Limits ${index + 1}`, content: <p>{source.limits}</p> },
    ]
  })
  pages.push(...topic.gaps.map((gap, index) => ({ title: `${gap.kind} ${index + 1}`, content: <p><strong className="font-semibold">{gap.kind}</strong>: {gap.text}</p> })))
  return <SettingsViews label="Study evidence entry" titles={pages.map((page) => page.title)}>
    {pages.map((page) => <div key={page.title} role="region" aria-label={page.title} className="text-[11px]">{page.content}</div>)}
  </SettingsViews>
}

/** Choices away from the documented reference; context ceiling and identity field names are inputs, not choices. Two or
 *  more together is what the completed one-choice-at-a-time studies did not cover. */
function changedChoices(article: ArticleSettings | undefined): number {
  if (!article) return 0
  return ARTICLE_KEYS.filter((key) => key !== 'context_tokens' && key !== 'identity_fields' &&
    (article[key] ?? undefined) !== (REFERENCE_ARTICLE[key] ?? undefined)).length
}

function Overview({ article, onUse }: { article: ArticleSettings | undefined; onUse: (point: StartingPoint) => void }) {
  const captionId = useId()
  const changed = changedChoices(article)
  return (
    <div className="mt-3 flex flex-col gap-3 text-[12px] text-ink">
      <SettingsViews label="Guide section" titles={['Extraction flow', 'Flow explained', 'Study scope', ...STARTING_POINTS.map((point) => point.name)]}>
      <div className="flex flex-col gap-2">
      <figure aria-labelledby={captionId} className="flex flex-col gap-2">
        <FlowDiagram />
        <figcaption id={captionId} className="sr-only">{FLOW_TEXT}</figcaption>
      </figure>
      </div>
      <p className="text-ink-muted">{FLOW_TEXT}</p>
      <div className="flex flex-col gap-2">
      <p className="text-ink-muted">{FLOW_NOTE}</p>
      {changed >= 2 && (
        <p>
          <strong className="font-semibold">Combination not studied</strong>
          {`: your Article draft changes ${changed} choices from the reference together. The completed studies changed one choice at a time; only the grounding pilot combined choices, on one selected document. Each finding holds only under its own study conditions.`}
        </p>
      )}
      </div>
      {STARTING_POINTS.map((point) => <StartingPointCard key={point.name} point={point} article={article} onUse={onUse} />)}
      </SettingsViews>
      <p className="text-ink-muted">Normal customization reaches every supported setting without these examples.</p>
    </div>
  )
}

function StartingPointCard({ point, article, onUse }: { point: StartingPoint; article: ArticleSettings | undefined; onUse: (point: StartingPoint) => void }) {
  const titleId = useId()
  const changesId = useId()
  const [shown, setShown] = useState(false)
  const delta = settingsDelta(article, withStartingPoint(article, point))
  return (
    <section aria-labelledby={titleId} className="flex flex-col items-start gap-1.5 rounded-xl border border-line p-2">
      <h4 id={titleId} className="text-[12.5px] font-semibold">{point.name}</h4>
      <p hidden={shown} className="text-ink-muted">{point.description}</p>
      <button type="button" aria-expanded={shown} aria-controls={changesId} onClick={() => setShown(!shown)} className={actionButton}>Show changes</button>
      {/* Every change can be inspected before these settings enter the draft. */}
      <div id={changesId} hidden={!shown}>
        {delta.length === 0
          ? <p>Your Article draft already uses these settings.</p>
          : <SettingsViews label="Starting point change" titles={delta.map((change) => change.label)}>{delta.map((change) => <p key={change.label}>{change.label}: {change.from} → {change.to}</p>)}</SettingsViews>}
      </div>
      <button type="button" disabled={!shown || delta.length === 0} onClick={() => onUse(point)}
        className="rounded-md border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink hover:bg-surface-muted disabled:text-ink-faint disabled:hover:bg-transparent disabled:hover:text-ink-faint">Use these settings</button>
    </section>
  )
}

/** The design's flowchart (§5), drawn locally; the figure's caption is its text equivalent. */
const NODE = { x: 26, width: 184, height: 28 } as const
const ROWS = ['Canonical Source Context', 'Context and grouping', 'Inventory and identity', 'Record values', 'Evidence verification', 'Extraction Result and review'] as const
const rowY = (index: number) => 4 + index * 48
const middle = (index: number) => rowY(index) + NODE.height / 2
const centre = NODE.x + NODE.width / 2
const down = (x: number, y: number) => `${x - 4},${y - 6} ${x + 4},${y - 6} ${x},${y}`
const right = (x: number, y: number) => `${x - 6},${y - 4} ${x - 6},${y + 4} ${x},${y}`
const left = (x: number, y: number) => `${x + 6},${y - 4} ${x + 6},${y + 4} ${x},${y}`
const POLICIES = { x: 232, width: 104 } as const

function FlowDiagram() {
  const box = (x: number, y: number, width: number, label: string) => (
    <g key={label}>
      <rect x={x} y={y} width={width} height={NODE.height} rx={6} className="fill-surface-muted stroke-line-strong" />
      <text x={x + width / 2} y={y + NODE.height / 2} textAnchor="middle" dominantBaseline="central" className="fill-ink text-[11px]">{label}</text>
    </g>
  )
  const context = ROWS.indexOf('Context and grouping')
  const values = ROWS.indexOf('Record values')
  const verification = ROWS.indexOf('Evidence verification')
  return (
    <svg viewBox="0 0 340 276" aria-hidden="true" focusable="false" className="h-auto max-h-48 w-full max-w-[22rem]">
      <g className="fill-none stroke-ink-muted" strokeWidth={1.25}>
        {ROWS.slice(1).map((label, index) => <line key={label} x1={centre} x2={centre} y1={rowY(index) + NODE.height} y2={rowY(index + 1) - 6} />)}
        {/* Context and grouping also feeds record values and verification directly. */}
        <path d={`M${NODE.x} ${middle(context)} H12 V${middle(verification)} H${NODE.x - 6} M12 ${middle(values)} H${NODE.x - 6}`} />
        <path d={`M${POLICIES.x} ${middle(verification)} H${NODE.x + NODE.width + 6}`} />
      </g>
      <g className="fill-ink-muted">
        {ROWS.slice(1).map((label, index) => <polygon key={label} points={down(centre, rowY(index + 1))} />)}
        <polygon points={right(NODE.x, middle(values))} />
        <polygon points={right(NODE.x, middle(verification))} />
        <polygon points={left(NODE.x + NODE.width, middle(verification))} />
      </g>
      {ROWS.map((label, index) => box(NODE.x, rowY(index), NODE.width, label))}
      {box(POLICIES.x, rowY(verification), POLICIES.width, 'Schema policies')}
    </svg>
  )
}
