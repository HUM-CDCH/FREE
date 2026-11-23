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
})
