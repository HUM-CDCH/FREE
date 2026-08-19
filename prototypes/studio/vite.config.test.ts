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
  it('routes only admitted API paths to their handler modules', () => {
    for (const [pathname, handler] of [
      ['/api/healthz', 'healthz'],
      ['/api/generate_schema', 'generate_schema'],
      ['/api/llm_inspector', 'llm_inspector'],
      ['/api/project-contexts', 'project_contexts'],
      ['/api/project-contexts/project', 'project_contexts'],
      ['/api/schema-revisions/revision', 'schema_revisions'],
      ['/api/extraction-schemas/schema', 'extraction_schemas'],
      ['/api/extractions/extraction/review', 'extractions'],
      ['/api/batch-extractions', 'batch_extractions'],
      ['/api/batch-extractions/batch', 'batch_extractions'],
      ['/api/batch-extractions/batch/retry', 'batch_extractions'],
      ['/api/batch-extractions/batch/results', 'batch_extractions'],
      ['/api/batch-schema-suggestions', 'batch_schema_suggestions'],
      ['/api/batch-schema-suggestions/suggestion/draft', 'batch_schema_suggestions'],
      ['/api/source-representations/representation/pdf', 'source_representations'],
    ] as const)
      expect(apiHandlerName(pathname, process.cwd())).toBe(handler)
  })

  it('rejects unknown suffixes beneath an admitted resource', () => {
    for (const pathname of [
      '/api/healthz/anything',
      '/api/batch-extractions/batch/anything-added-later',
      '/api/batch-extractions/batch/results/anything',
      '/api/source-representations/representation/pdf/anything',
    ])
      expect(apiHandlerName(pathname, process.cwd())).toBeNull()
  })

  it('routes the Source Documents nested under a Project Context by their own table', () => {
    expect(
      apiHandlerName(
        '/api/project-contexts/project/source-documents',
        process.cwd(),
      ),
    ).toBe('source_documents')
    expect(
      apiHandlerName(
        '/api/project-contexts/project/source-documents/document',
        process.cwd(),
      ),
    ).toBe('source_documents')
    expect(
      apiHandlerName(
        '/api/project-contexts/project/source-documents/document/reopen',
        process.cwd(),
      ),
    ).toBe('document_reopen')
  })

  it('answers no handler for a private module, an unknown resource, or a traversal', () => {
    for (const pathname of [
      '/api/_model_config',
      '/api/_provider',
      '/api/nope',
      '/api/Extractions',
      '/api/',
      '/api/../package.json',
      '/api/source-documents',
    ])
      expect(apiHandlerName(pathname, process.cwd())).toBeNull()
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
