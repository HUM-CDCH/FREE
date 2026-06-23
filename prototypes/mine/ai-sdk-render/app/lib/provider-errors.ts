import type { AiProviderSettings } from './provider-settings'

type ProviderFailureContext = {
  operation: string
  providerSettings: AiProviderSettings
}

const INTERESTING_ERROR_KEYS = [
  'message',
  'name',
  'code',
  'status',
  'statusCode',
  'responseBody',
  'body',
  'data',
  'error',
  'cause',
  'lastError',
  'errors',
  'reason',
] as const

export function describeProviderFailure({ operation, providerSettings }: ProviderFailureContext, error: unknown) {
  const providerName = providerSettings.provider === 'docker-runner' ? 'Docker Model Runner' : 'Ollama'
  const providerContext = `${providerName} at ${providerSettings.baseURL} using model ${providerSettings.model}`
  const details = normalizeErrorText(error) || 'No provider error details were returned.'
  const lowerDetails = details.toLowerCase()

  if (providerSettings.provider === 'docker-runner' && isDockerModelLoadFailure(lowerDetails)) {
    return `${operation} failed with ${providerContext}. Docker Model Runner could not load or run the model. This commonly happens when CUDA/GPU memory is insufficient for NuExtract3. Use the default Ollama provider for this prototype, choose a smaller quantization, or run Docker Model Runner on a machine with more GPU memory. Provider error: ${details}`
  }

  if (isProviderUnreachable(lowerDetails)) {
    const setup =
      providerSettings.provider === 'ollama'
        ? `Start Ollama with "ollama serve", then install the model with "ollama pull ${providerSettings.model}".`
        : `Start Docker Model Runner and confirm ${providerSettings.baseURL}/models is reachable.`
    return `${operation} failed with ${providerContext}. The provider is unreachable. ${setup} Provider error: ${details}`
  }

  if (isModelMissing(lowerDetails)) {
    const setup =
      providerSettings.provider === 'ollama'
        ? `Install the model with "ollama pull ${providerSettings.model}", or select a model that appears in "ollama list".`
        : `Select a model returned by ${providerSettings.baseURL}/models. The expected Docker Runner NuExtract3 model ID is huggingface.co/numind/nuextract3-gguf:Q4_K_M.`
    return `${operation} failed with ${providerContext}. The selected model is not installed or not exposed by the provider. ${setup} Provider error: ${details}`
  }

  return `${operation} failed with ${providerContext}. Check that the provider is running, the selected model is installed, and the provider has enough memory to load it. Provider error: ${details}`
}

function isDockerCudaMemoryFailure(details: string) {
  return (
    details.includes('cuda') ||
    details.includes('gpu memory') ||
    details.includes('out of memory') ||
    details.includes('not enough gpu') ||
    details.includes('not enough memory') ||
    details.includes('failed to load the model') ||
    details.includes('llama.cpp failed')
  )
}

function isDockerModelLoadFailure(details: string) {
  return (
    isDockerCudaMemoryFailure(details) ||
    details.includes('internal server error') ||
    details.includes('bad gateway') ||
    details.includes('status code: 500') ||
    details.includes('statuscode: 500')
  )
}

function isProviderUnreachable(details: string) {
  return (
    details.includes('econnrefused') ||
    details.includes('connection refused') ||
    details.includes('fetch failed') ||
    details.includes('failed to fetch') ||
    details.includes('connect timeout') ||
    details.includes('connection error') ||
    details.includes('socket hang up')
  )
}

function isModelMissing(details: string) {
  return (
    details.includes('model') &&
    (details.includes('not found') ||
      details.includes('no such model') ||
      details.includes('not installed') ||
      details.includes('does not exist') ||
      details.includes('try pulling') ||
      details.includes('404'))
  )
}

function normalizeErrorText(error: unknown) {
  const chunks = collectErrorText(error)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
  const uniqueChunks = [...new Set(chunks)]
  return truncate(uniqueChunks.join(' | '), 3000)
}

function collectErrorText(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (!value || typeof value !== 'object') {
    return []
  }
  if (seen.has(value)) {
    return []
  }
  seen.add(value)

  const chunks: string[] = []
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorText(item, seen))
  }

  if (value instanceof Error) {
    chunks.push(`${value.name}: ${value.message}`)
    chunks.push(...collectErrorText(value.cause, seen))
  }

  const record = value as Record<string, unknown>
  for (const key of INTERESTING_ERROR_KEYS) {
    const nested = record[key]
    if (typeof nested === 'string' || typeof nested === 'number' || typeof nested === 'boolean') {
      chunks.push(String(nested))
    } else if (nested && typeof nested === 'object') {
      chunks.push(...collectErrorText(nested, seen))
    }
  }

  return chunks.map((chunk) => truncate(chunk, 1000))
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
