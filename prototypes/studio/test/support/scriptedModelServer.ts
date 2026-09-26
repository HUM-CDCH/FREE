import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A text reply answers one chat completion; an error reply writes its status and body, with `{{authorization}}` in the
 *  body replaced by the request's authorization header (how a provider echoes a key into an error). `hold` withholds
 *  the reply until `release()`. */
export type ScriptedReply =
  | { text: string; hold?: boolean; headers?: Readonly<Record<string, string>> }
  | { status: number; body: string; headers?: Readonly<Record<string, string>> }

export type ScriptedCall = Readonly<{
  authorization: string | null
  body: unknown
  receivedAt: number
  /** When the response finished or the connection closed; null while the call is held. */
  closedAt: number | null
}>

export type ScriptedModelServer = Readonly<{
  baseUrl: string
  reply(...replies: ScriptedReply[]): void
  calls(): readonly ScriptedCall[]
  /** Resolves with the n-th call (1-based) once it arrived. */
  waitForCall(count: number, timeoutMs?: number): Promise<ScriptedCall>
  release(): void
  close(): Promise<void>
}>

type Recorded = { authorization: string | null; body: unknown; receivedAt: number; closedAt: number | null }

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (text += chunk))
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

function completion(text: string): string {
  return JSON.stringify({
    id: 'scripted', object: 'chat.completion', created: 0, model: 'scripted',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

/**
 * An OpenAI-compatible chat-completions server on 127.0.0.1 for the PostgreSQL and Playwright tiers. Replies are
 * taken FIFO from `reply(...)`; with none queued it answers `scripted answer`. A request with `stream: true` is 400:
 * no M5 call streams (Ruling 5).
 */
export async function startScriptedModelServer(): Promise<ScriptedModelServer> {
  const queue: ScriptedReply[] = []
  const recorded: Recorded[] = []
  const held: (() => void)[] = []
  const waiters: { count: number; resolve: (call: ScriptedCall) => void }[] = []
  const notify = () => {
    for (const waiter of [...waiters]) {
      const call = recorded[waiter.count - 1]
      if (call) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(call)
      }
    }
  }
  const server: Server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not scripted"}')
      return
    }
    const raw = await readBody(request)
    let body: unknown = raw
    try { body = JSON.parse(raw) } catch { /* recorded as text */ }
    const authorization = request.headers.authorization ?? null
    const call: Recorded = { authorization, body, receivedAt: Date.now(), closedAt: null }
    recorded.push(call)
    response.once('close', () => { call.closedAt ??= Date.now() })
    notify()
    if (typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"error":"streaming is not scripted"}')
      return
    }
    const scripted = queue.shift() ?? { text: 'scripted answer' }
    const send = () => {
      if ('status' in scripted) {
        response.writeHead(scripted.status, { 'content-type': 'application/json', ...scripted.headers })
        response.end(scripted.body.replaceAll('{{authorization}}', authorization ?? ''))
      } else {
        response.writeHead(200, { 'content-type': 'application/json', ...scripted.headers })
        response.end(completion(scripted.text))
      }
    }
    if ('hold' in scripted && scripted.hold) held.push(send)
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reply: (...replies) => { queue.push(...replies) },
    calls: () => recorded.map((call) => ({ ...call })),
    waitForCall: (count, timeoutMs = 10_000) => new Promise<ScriptedCall>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Call ${count} did not arrive within ${timeoutMs} ms.`)), timeoutMs)
      waiters.push({ count, resolve: (call) => { clearTimeout(timer); resolve(call) } })
      notify()
    }),
    release: () => { for (const send of held.splice(0)) send() },
    close: () => new Promise<void>((resolve, reject) => {
      for (const send of held.splice(0)) send()
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  }
}
