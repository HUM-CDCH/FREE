import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type UIMessage,
} from 'ai'
import { prepareChatModel } from '@/app/lib/nuextract'
import { normalizeProviderSettings } from '@/app/lib/provider-settings'
import { ollama } from 'ai-sdk-ollama/browser'

export const maxDuration = 30

export async function POST(req: Request) {
  let body: {
    messages?: unknown
    message?: unknown
    providerSettings?: unknown
  }

  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }

  const incomingMessages = Array.isArray(body.messages)
    ? body.messages
    : body.message
      ? [body.message]
      : []

  if (incomingMessages.length === 0) {
    return Response.json({ error: 'Provide at least one chat message.' }, { status: 400 })
  }

  let messages: UIMessage[]
  try {
    messages = await validateUIMessages<UIMessage>({ messages: incomingMessages })
  } catch (error) {
    console.error('Invalid chat messages', error)
    return Response.json({ error: 'Chat messages are invalid.' }, { status: 400 })
  }

  try {
    const providerSettings = normalizeProviderSettings(body.providerSettings)
    const result = streamText({
      model: ollama('hf.co/numind/NuExtract3-GGUF:Q2_K'),
      system:
        'You are FREE, a grounded assistant for humanities researchers. Answer about source documents, annotations, extraction schemas, extraction results, and evidence. Be concise and do not invent source evidence.',
      messages: await convertToModelMessages(messages),
    })

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error('Chat model stream failed', error)
        return error instanceof Error ? error.message : 'The selected model provider failed.'
      },
    })
  } catch (error) {
    console.error('Unable to start chat model stream', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to start chat.' },
      { status: 502 },
    )
  }
}
