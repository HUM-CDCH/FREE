import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import studioConfig, {
  apiHandlerName,
  localHttps,
  readBody,
} from './vite.config.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'free-studio-vite-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function request(chunks: Buffer[], contentLength?: number): IncomingMessage {
  const stream = Readable.from(chunks) as IncomingMessage
  stream.headers = contentLength
    ? { 'content-length': String(contentLength) }
    : {}
  return stream
}

describe('Vite API request admission', () => {
  it('routes the hyphenated batch schema endpoint through its explicit table', () => {
    expect(apiHandlerName('/api/batch-schema-suggestions', process.cwd())).toBe(
      'batch_schema_suggestions',
    )
  })

  it('routes an Extraction Schema member rename to extraction_schemas', () => {
    expect(
      apiHandlerName('/api/extraction-schemas/schema', process.cwd()),
    ).toBe('extraction_schemas')
  })

  it('routes a Source Document member DELETE target to source_documents', () => {
    expect(
      apiHandlerName(
        '/api/project-contexts/project/source-documents/document',
        process.cwd(),
      ),
    ).toBe('source_documents')
  })

  it('routes only the exact Source Document reopen target to document_reopen', () => {
    expect(
      apiHandlerName(
        '/api/project-contexts/project/source-documents/document/reopen',
        process.cwd(),
      ),
    ).toBe('document_reopen')
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

describe('Vite HTTPS mode', () => {
  it('fails clearly when certificate files are missing', () => {
    expect(() => localHttps(temporaryDirectory())).toThrowError(
      /HTTPS mode requires readable certificate files.*mkcert.*for HTTP/,
    )
  })

  it('fails clearly when a certificate file is unreadable', () => {
    const certificates = temporaryDirectory()
    writeFileSync(join(certificates, 'studio.pem'), 'certificate')
    mkdirSync(join(certificates, 'studio-key.pem'))

    expect(() => localHttps(certificates)).toThrowError(
      /HTTPS mode requires readable certificate files.*mkcert.*for HTTP/,
    )
  })

  it('loads existing certificate files', () => {
    const certificates = temporaryDirectory()
    writeFileSync(join(certificates, 'studio.pem'), 'certificate')
    writeFileSync(join(certificates, 'studio-key.pem'), 'key')

    expect(localHttps(certificates)).toEqual({
      https: {
        cert: Buffer.from('certificate'),
        key: Buffer.from('key'),
      },
    })
  })

  it('leaves ordinary development mode on HTTP', async () => {
    const config = await studioConfig({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    })

    expect(config.server).toEqual({ host: '127.0.0.1' })
  })
})
