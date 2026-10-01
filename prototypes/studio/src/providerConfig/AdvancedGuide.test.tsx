// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { ExplainButton, GuideProvider, HowThisWorksButton } from './AdvancedGuide'
import { EVIDENCE_SOURCES, GUIDE_TOPICS } from './advancedGuide.data'
import { STARTING_POINTS } from './advancedSettings'

afterEach(cleanup)

function renderGuide(onUseSettings = vi.fn(), article = REFERENCE_ARTICLE) {
  render(
    <GuideProvider article={article} onUseSettings={onUseSettings}>
      <ExplainButton topic="grounding" subject="Evidence" />
      <ExplainButton topic="catalog" subject="Recipe Catalog" />
      <HowThisWorksButton />
    </GuideProvider>,
  )
  return onUseSettings
}
const dismiss = (dialog: HTMLElement) => fireEvent(dialog, new Event('cancel', { cancelable: true }))
const explainEvidence = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Explain Evidence' }))
  return screen.getByRole('dialog', { name: 'Verification' })
}

function selectView(label: string, title: string) {
  const select = screen.getByRole('combobox', { name: label })
  const option = within(select).getByRole('option', { name: title }) as HTMLOptionElement
  fireEvent.change(select, { target: { value: option.value } })
}

describe('the Explain guide', () => {
  it('opens at the section topic with Meaning, Example and Study evidence; Escape returns focus to the trigger', async () => {
    renderGuide()
    const trigger = screen.getByRole('button', { name: 'Explain Evidence' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Verification' })
    for (const title of ['Meaning', 'Example', 'Study evidence']) {
      selectView('Topic section', title)
      expect(within(dialog).getByRole('heading', { name: title })).toBeVisible()
    }
    selectView('Topic section', 'Technical details')
    expect(within(dialog).getByText('Technical details', { selector: 'summary' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull()
    dismiss(dialog)
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('exploring the span example changes no settings and shows the exact limits', () => {
    const onUseSettings = renderGuide()
    const dialog = explainEvidence()
    selectView('Topic section', 'Example')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Source span E1' }))
    expect(within(dialog).getByText('Text range is exact. Highlight precision depends on available geometry.')).toBeInTheDocument()
    expect(within(dialog).getByText('E1 is a compact transport label, not the stored evidence ID.')).toBeInTheDocument()
    expect(within(dialog).getByText('Exact source location alone is not proof that the entire claim is supported. Wrong-subject 15.6 must not become support.')).toBeInTheDocument()
    expect(within(dialog).getByText(/linked a compound claim the source only partly supports/)).toBeInTheDocument()
    expect(onUseSettings).not.toHaveBeenCalled()
  })

  it('the span example highlights a sentence inside its passage and a cell inside its row, with each range in words', () => {
    renderGuide()
    const dialog = explainEvidence()
    selectView('Topic section', 'Example')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Source span E1' }))
    expect([...dialog.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['ASC: 18.6 °C', '18.6'])
    const figure = within(dialog).getByRole('figure')
    expect(figure).toHaveAccessibleName(/exact code-point range 0–12/)
    expect(figure).toHaveAccessibleName(/exact cell; its row and column headers are context/)
  })

  it('section navigation reveals one view and keeps its control focused without adding a URL fragment', () => {
    renderGuide()
    const dialog = explainEvidence()
    const navigation = within(dialog).getByRole('combobox', { name: 'Topic section' })
    navigation.focus()
    selectView('Topic section', 'Study evidence')
    expect(within(dialog).getByRole('heading', { name: 'Study evidence' })).toBeVisible()
    expect(within(dialog).queryByRole('heading', { name: 'Meaning' })).toBeNull()
    expect(navigation).toHaveFocus()
    expect(window.location.hash).toBe('')
  })

  it('study evidence names date, corpus, revision and evidence type; unmeasured effects say so', () => {
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Explain Recipe Catalog' }))
    const dialog = screen.getByRole('dialog', { name: 'Catalog' })
    expect(within(dialog).getAllByText('Not measured').length).toBeGreaterThan(0)
    selectView('Topics', 'Verification')
    selectView('Topic section', 'Study evidence')
    selectView('Study evidence entry', 'Study details 1')
    const study = within(screen.getByRole('region', { name: 'Study details 1' }))
    for (const label of ['Date', 'Corpus', 'Method revision', 'Evidence type'])
      expect(study.getByText(label, { selector: 'dt' })).toBeVisible()
    expect(study.getByText('2026-09-28')).toBeVisible()
    selectView('Study evidence entry', 'Limits 1')
    expect(screen.getByRole('region', { name: 'Limits 1' })).toBeVisible()
  })

  it('keeps the selected-document pilot and the Harvey diagnostic in separate views, each with its own corpus', () => {
    renderGuide()
    explainEvidence()
    selectView('Topic section', 'Study evidence')
    const evidence = GUIDE_TOPICS.find((topic) => topic.id === 'grounding')!.evidence
    const pilots = evidence.map((row, index) => ({ row, index })).filter(({ row }) => ['pilot', 'harvey'].includes(row.source))
    expect(pilots.length).toBeGreaterThan(1)
    for (const { row, index } of pilots) {
      const source = EVIDENCE_SOURCES.find((item) => item.id === row.source)!
      selectView('Study evidence entry', `Finding ${index + 1}`)
      expect(screen.getByRole('region', { name: `Finding ${index + 1}` })).toHaveTextContent(source.title)
      selectView('Study evidence entry', `Study details ${index + 1}`)
      const details = screen.getByRole('region', { name: `Study details ${index + 1}` })
      expect(details).toHaveTextContent(row.source === 'pilot' ? 'One selected development document' : 'One previously inspected development document')
      if (row.source === 'harvey') expect(details).not.toHaveTextContent('selected development document')
    }
  })

  it('every topic has a purpose, stage, example, figure text, combinations and a verbatim takeaway', () => {
    expect(GUIDE_TOPICS.map((topic) => topic.id)).toEqual(['scope', 'grouping', 'selection', 'identity', 'format', 'grounding', 'policy', 'scheduling', 'catalog'])
    for (const topic of GUIDE_TOPICS) {
      for (const text of [topic.purpose, topic.stage, topic.combinations, topic.takeaway, topic.technical]) expect(text.length).toBeGreaterThan(10)
      expect(topic.example.options.length).toBeGreaterThan(1)
      for (const option of topic.example.options) expect(option.outcome.length).toBeGreaterThan(10)
      for (const row of topic.evidence) expect(EVIDENCE_SOURCES.map((source) => source.id)).toContain(row.source)
    }
    expect(GUIDE_TOPICS.find((topic) => topic.id === 'selection')!.takeaway)
      .toBe('Lower value-call count can omit relevant evidence. It is not grounding routing.')
    expect(GUIDE_TOPICS.find((topic) => topic.id === 'catalog')!.takeaway)
      .toBe("Verification Off yields proposals; a recipe's applicability is source-specific.")
    for (const source of EVIDENCE_SOURCES) for (const field of [source.date, source.corpus, source.revision, source.evidence, source.limits]) expect(field).not.toBe('')
  })

  it('every study names its document count and states the semantic review it still lacks', () => {
    for (const source of EVIDENCE_SOURCES) {
      expect(source.corpus, source.id).toMatch(/\b(one|two|five|six|\d+)\b[^;]*\bdocuments?\b/i)
      expect(source.limits, source.id).toMatch(/(semantic|human) (adjudication|review)/i)
    }
    expect(EVIDENCE_SOURCES.find((source) => source.id === 'r1r3r4')!.revision).toMatch(/R1.*v11.*R4.*v12/)
  })

  it('makes no recommendation, speed or accuracy claim', () => {
    const text = JSON.stringify([GUIDE_TOPICS, EVIDENCE_SOURCES, STARTING_POINTS])
    expect(text).not.toMatch(/\bbest\b|\bfastest\b|\bfaster\b|\bbetter\b|\bcheaper\b|\bimprov|\brecommended\b|more accurate|\bsafer\b/i)
  })

  it('How this works shows the flow with a text equivalent and each starting point\'s full delta before it is used', () => {
    const onUseSettings = renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const dialog = screen.getByRole('dialog', { name: 'How this works' })
    expect(within(dialog).getByRole('figure')).toHaveAccessibleName(/Canonical Source Context feeds Context and grouping/)
    selectView('Guide section', 'Explore spans and schema policies')
    const point = within(dialog).getByRole('region', { name: 'Explore spans and schema policies' })
    expect(within(point).getByRole('button', { name: 'Use these settings' })).toBeDisabled()
    fireEvent.click(within(point).getByRole('button', { name: 'Show changes' }))
    expect(within(point).getByText('Source labels → Source spans', { exact: false })).toBeInTheDocument()
    fireEvent.click(within(point).getByRole('button', { name: 'Use these settings' }))
    expect(onUseSettings).toHaveBeenCalledWith(expect.objectContaining({ grounding: 'spans', evidence_policy: 'schema', context: 'bounded' }), STARTING_POINTS[1]!.name)
  })

  it('a draft that changes two or more choices says Combination not studied; the reference does not', () => {
    renderGuide(vi.fn(), { ...REFERENCE_ARTICLE, context: 'bounded', rendering: 'structured' })
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const guide = within(screen.getByRole('dialog', { name: 'How this works' }))
    expect(guide.getByText('Combination not studied')).toBeInTheDocument()
    // What the studies did, not an inference from how many choices changed.
    expect(guide.getByText(/completed studies changed one choice at a time/)).toBeInTheDocument()
    cleanup()
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    expect(within(screen.getByRole('dialog', { name: 'How this works' })).queryByText('Combination not studied')).toBeNull()
  })

  it('a starting point the draft already uses shows no changes and cannot be used again', () => {
    renderGuide(vi.fn(), { ...REFERENCE_ARTICLE })
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    selectView('Guide section', 'Reference controls')
    const point = within(within(screen.getByRole('dialog', { name: 'How this works' })).getByRole('region', { name: 'Reference controls' }))
    fireEvent.click(point.getByRole('button', { name: 'Show changes' }))
    expect(point.getByText('Your Article draft already uses these settings.')).toBeInTheDocument()
    expect(point.getByRole('button', { name: 'Use these settings' })).toBeDisabled()
  })
})
