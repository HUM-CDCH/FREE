import { describe, expect, it } from 'vitest'
import { chatIntentOf, chatIntentPrompt } from './_chat_intent.js'

describe('chatIntentOf', () => {
  it('reads an intent whatever its case, and a focus only for a template asked for', async () => {
    await expect(chatIntentOf('{"intent":"question","focus":null}')).resolves.toEqual({ intent: 'question', focus: null })
    await expect(chatIntentOf('```json\n{"intent":" Generate ","focus":" the dates "}\n```')).resolves.toEqual({ intent: 'generate', focus: 'the dates' })
    await expect(chatIntentOf('{"intent":"edit","focus":"add a date"}')).resolves.toEqual({ intent: 'edit', focus: null })
    await expect(chatIntentOf('{"intent":"generate","focus":""}')).resolves.toEqual({ intent: 'generate', focus: null })
    await expect(chatIntentOf('{"intent":"correct","focus":"record 3"}')).resolves.toEqual({ intent: 'correct', focus: null })
  })

  it('reads nothing from a reply that names no known intent', async () => {
    await expect(chatIntentOf('{"intent":"approve"}')).resolves.toBeNull()
    await expect(chatIntentOf('{"answer":"42"}')).resolves.toBeNull()
    await expect(chatIntentOf('not json')).resolves.toBeNull()
  })
})

describe('chatIntentPrompt', () => {
  it('names every intent, whatever the state, with the conversation and what the chat offered', () => {
    const prompt = chatIntentPrompt({
      message: 'yes',
      history: [{ role: 'user', text: 'How long is grave 8?' }, { role: 'assistant', text: '1.72 metres.' }],
      offer: 'Run extraction: Run the extraction on register.pdf?',
    })
    for (const intent of ['question', 'generate', 'edit', 'correct', 'extract', 'confirm', 'none']) expect(prompt).toContain(`- "${intent}":`)
    expect(prompt).toContain('Studio shows them as the "template"')
    expect(prompt).toContain('Researcher: How long is grave 8?\nAssistant: 1.72 metres.')
    expect(prompt).toContain('Studio has just offered: Run extraction: Run the extraction on register.pdf?')
    expect(prompt).toContain('The researcher\'s latest chat message:\nyes')
    expect(chatIntentPrompt({ message: 'hi', history: [] })).not.toContain('Studio has just offered:')
  })

  it('says where the message was said as context, and leaves a message that could be either to "correct", whose next step decides (ADR 0043)', () => {
    const at = (view: 'chat' | 'template' | 'results', results: boolean) => chatIntentPrompt({ message: 'the date is wrong', history: [], where: { view, results } })
    expect(at('results', true)).toContain('The researcher is looking at the extracted results. Extracted results are shown.')
    expect(at('template', false)).toContain('The researcher is looking at the template. No extracted results are shown.')
    for (const prompt of [at('results', true), at('template', true), at('chat', false)]) {
      expect(prompt).toContain('A message that could be "edit" or "correct" is "correct"')
      expect(prompt).not.toContain('could be read either')
    }
    // "edit" is the template's structure alone; anything about what was extracted is "correct".
    expect(at('chat', true)).toContain('- "edit": changes the template\'s structure and says nothing about what was extracted')
    expect(at('chat', true)).toContain('a field was read wrongly (in one value or in all of them), or how values should be read')
    expect(chatIntentPrompt({ message: 'hi', history: [] })).not.toContain('The researcher is looking at')
  })
})
