// The black-box system suite keeps parsing, DBOS and grounding real. Only the
// external instruction-model boundary is deterministic for its probe PDF: it
// counts tokens as vLLM's /tokenize does and answers the Article pipeline's
// calls (inventory, record values, evidence decisions) from the real parser
// text in each prompt, like the service tier's scripted model.
import { createServer } from 'node:http'

/** The probe PDF's one record, as the contract suite's schema (author, year, place) reads it. */
const RECORD = { author: 'Margaret Cavendish', year: 1666, place: 'London' }

function answerFor(body) {
  // Schema Suggestion (page-span excerpts scenario): log only what the prompt carried, answer a minimal template.
  const text = body.messages.map((message) =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  if (text.includes('for schema design')) {
    const ids = (kind) => [...new Set([...text.matchAll(new RegExp(`PAGE${kind}(\\d\\d)`, 'g'))].map((match) => match[1]))].sort()
    console.log('SUGGEST ' + JSON.stringify({
      chars: text.length,
      everyPage: text.includes('from every physical page'),
      omittedMarks: text.split('[... omitted for schema design ...]').length - 1,
      starts: ids('START'),
      ends: ids('END'),
      nordic: text.includes('æøå'),
    }))
    return { _description: 'One grave entry.', entry: 'string' }
  }
  const prompt = body.messages.at(-1).content
  const properties = body.response_format.json_schema.schema.properties
  if (!prompt.includes('Margaret Cavendish') || !prompt.includes('1666'))
    throw new Error('The contract model received an unexpected document')
  if ('records' in properties) {
    // Inventory: the one record, owning every passage that mentions it.
    const passages = [...prompt.matchAll(/\[(p\d+_s\d+)\]([^]*?)(?=\[p\d+_s\d+\]|$)/g)]
      .filter((match) => match[2].includes('Margaret Cavendish'))
      .map((match) => match[1])
    return { records: [{ label: RECORD.author, identity: { author: RECORD.author }, passages }] }
  }
  const keys = Object.keys(properties)
  if (keys.length > 0 && keys.every((key) => /^C\d+$/.test(key))) {
    // Evidence decisions: each claim's value is supported by the offered unit that contains it.
    const claims = [...prompt.matchAll(/^(C\d+) \([^\n]*\): ([^\n]+)$/gm)]
    const evidence = [...prompt.matchAll(/^(E\d+): ([^\n]+)$/gm)]
    return Object.fromEntries(claims.map(([, claim, value]) =>
      [claim, evidence.find(([, , text]) => text.includes(value))?.[1] ?? 'NONE']))
  }
  if (keys.length > 0 && keys.every((key) => key in RECORD))
    return Object.fromEntries(keys.map((key) => [key, RECORD[key]]))
  throw new Error(`Unexpected model schema: ${JSON.stringify(properties)}`)
}

createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || !['/v1/chat/completions', '/tokenize'].includes(request.url ?? ''))
      throw new Error(`Unexpected model request: ${request.method} ${request.url}`)
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes)
    // A verified count stands in for vLLM's /tokenize; every completion reports the same count, as a real server does.
    const counted = body.messages.reduce((total, message) =>
      total + String(message.content).split(/\s+/).filter(Boolean).length, 0) + 7
    if (request.url === '/tokenize') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ count: counted, max_model_len: 16384 }))
      return
    }
    const answer = answerFor(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: counted, completion_tokens: 30 },
    }))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error) }))
  }
}).listen(8000, '0.0.0.0')
