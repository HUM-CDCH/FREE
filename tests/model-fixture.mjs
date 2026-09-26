// The black-box system suite keeps parsing, DBOS and grounding real. Only the
// external instruction-model response is deterministic for its probe PDF.
import { createServer } from 'node:http'

createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
      throw new Error('Unexpected model request')
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes)
    const prompt = body.messages.at(-1).content
    const properties = body.response_format.json_schema.schema.properties
    if (!('records' in properties) || !prompt.includes('Margaret Cavendish') || !prompt.includes('1666'))
      throw new Error('The contract model received an unexpected document or schema')
    const answer = { records: [{ author: 'Margaret Cavendish', year: 1666, place: 'London' }] }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    }))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error) }))
  }
}).listen(8000, '0.0.0.0')
