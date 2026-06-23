import { streamText, UIMessage, convertToModelMessages } from 'ai';
import { ollama } from 'ai-sdk-ollama';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: ollama("hf.co/numind/NuExtract3-GGUF:Q4_K_M"),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}