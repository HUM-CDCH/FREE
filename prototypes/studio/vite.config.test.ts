import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apiHandlerName, readBody } from './vite.config.js'

function request(chunks: Buffer[], contentLength?: number): IncomingMessage {
  const stream = Readable.from(chunks) as IncomingMessage
  stream.headers = contentLength
    ? { 'content-length': String(contentLength) }
    : {}
  return stream
}

describe('Vite API request admission', () => {
  it('routes the hyphenated batch schema endpoint through its explicit table', () => {
    expect(
      apiHandlerName('/api/batch-schema-suggestions', process.cwd()),
    ).toBe('batch_schema_suggestions')
  })

  it('rejects declared and streamed bodies before buffering past the limit', async () => {
    await expect(readBody(request([], 11), 10)).rejects.toMatchObject({
      status: 413,
    })
    await expect(
      readBody(request([Buffer.alloc(6), Buffer.alloc(5)]), 10),
    ).rejects.toMatchObject({ status: 413 })
  })
})
