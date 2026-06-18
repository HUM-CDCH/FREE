import { convertToModelMessages, streamText, type UIMessage } from 'ai'
import { prepareChatModel } from '@/app/lib/nuextract'
import { normalizeProviderSettings } from '@/app/lib/provider-settings'

export const maxDuration = 30

export async function POST(req: Request) {
  const body = (await req.json()) as {
    messages?: UIMessage[]
    message?: UIMessage
    providerSettings?: unknown
  }
  const messages = Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : []

  if (messages.length === 0) {
    return Response.json({ error: 'Provide at least one chat message.' }, { status: 400 })
  }

  // The source document rides along as image parts on the user message (see
  // ChatTab.sourceFileParts), so convertToModelMessages already carries it.
  const providerSettings = normalizeProviderSettings(body.providerSettings)
  const result = streamText({
    model: prepareChatModel(providerSettings),
    system:
      'You are FREE, a grounded assistant for humanities researchers. Answer about source documents, annotations, extraction schemas, extraction results, and evidence. Be concise and do not invent source evidence.',
    messages: await convertToModelMessages(messages),
  })

  return result.toUIMessageStreamResponse()
}
