import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ApiConfigGroup, LLMRequest } from '@/types'

vi.mock('@/services/llm/http', () => ({ llmFetch: vi.fn() }))
import { llmFetch } from '@/services/llm/http'

import { imageDataUrl, openAiVisionContent } from '@/services/llm/adapters/vision'
import { OpenAIAdapter } from '@/services/llm/adapters/OpenAIAdapter'
import { DeepSeekAdapter } from '@/services/llm/adapters/DeepSeekAdapter'
import { GroqAdapter } from '@/services/llm/adapters/GroqAdapter'
import { AnthropicAdapter } from '@/services/llm/adapters/AnthropicAdapter'
import { GeminiAdapter } from '@/services/llm/adapters/GeminiAdapter'
import { OllamaAdapter } from '@/services/llm/adapters/OllamaAdapter'
import { ResponsesAdapter } from '@/services/llm/adapters/ResponsesAdapter'

const llmFetchMock = llmFetch as unknown as ReturnType<typeof vi.fn>

const PNG = 'iVBORw0KGgo='
const image = { mimeType: 'image/png', dataBase64: PNG }

function config(provider: ApiConfigGroup['provider']): ApiConfigGroup {
  return {
    id: 'g1',
    name: provider,
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    systemPrompt: '',
    defaultModel: '',
    provider,
    customHeaders: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function request(messages: LLMRequest['messages']): LLMRequest {
  return {
    model: 'some-model',
    messages,
    temperature: 0,
    maxTokens: 512,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: false,
  }
}

/**
 * Run one adapter against a mocked transport and return the JSON it POSTed.
 * The response payload is deliberately empty: every adapter reads it through
 * optional chaining, so the request body is the only thing under test here.
 */
async function sentBody(
  adapter: { sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<unknown> },
  provider: ApiConfigGroup['provider'],
  messages: LLMRequest['messages']
): Promise<any> {
  llmFetchMock.mockResolvedValue(
    new Response(JSON.stringify({ choices: [], content: [], candidates: [], output: [], message: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  // A test may send through several adapters in a row — judge each request on
  // its own call.
  llmFetchMock.mockClear()
  const iter = adapter.sendRequest(request(messages), config(provider))
  while (!(await iter.next()).done) { /* drain to the request */ }
  expect(llmFetchMock).toHaveBeenCalledTimes(1)
  return JSON.parse(llmFetchMock.mock.calls[0][1].body)
}

const visionTurn = [{ role: 'user' as const, content: '这张图里是什么？', images: [image] }]

describe('vision.ts helpers', () => {
  it('wraps raw base64 in a data URL and leaves an existing one alone', () => {
    expect(imageDataUrl(image)).toBe(`data:image/png;base64,${PNG}`)
    expect(imageDataUrl({ mimeType: 'image/png', dataBase64: 'data:image/png;base64,AAA' }))
      .toBe('data:image/png;base64,AAA')
  })

  it('builds OpenAI content parts for user turns with images only', () => {
    expect(openAiVisionContent({ role: 'user', content: 'hi', images: [image] })).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
    expect(openAiVisionContent({ role: 'user', content: 'hi' })).toBeUndefined()
    // Assistant / tool turns never carry images on the wire.
    expect(openAiVisionContent({ role: 'assistant', content: 'hi', images: [image] })).toBeUndefined()
    // Image-only turn: no empty text part.
    expect(openAiVisionContent({ role: 'user', content: '', images: [image] })).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })
})

describe('adapters emit provider-native image parts', () => {
  beforeEach(() => {
    llmFetchMock.mockReset()
  })

  it('openai-compatible: content becomes a text + image_url array', async () => {
    const body = await sentBody(new OpenAIAdapter(), 'openai', visionTurn)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })

  it('deepseek / groq share the OpenAI content-part shape', async () => {
    for (const [adapter, provider] of [[new DeepSeekAdapter(), 'deepseek'], [new GroqAdapter(), 'groq']] as const) {
      const body = await sentBody(adapter, provider, visionTurn)
      expect(body.messages[0].content[1]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${PNG}` },
      })
    }
  })

  it('anthropic: image block first, text after (keeps the cache breakpoint on the tail)', async () => {
    const body = await sentBody(new AnthropicAdapter(), 'anthropic', visionTurn)
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: '这张图里是什么？' },
    ])
  })

  it('gemini: inlineData part alongside the text part', async () => {
    const body = await sentBody(new GeminiAdapter(), 'gemini', visionTurn)
    expect(body.contents[0].parts).toEqual([
      { text: '这张图里是什么？' },
      { inlineData: { mimeType: 'image/png', data: PNG } },
    ])
  })

  it('ollama: plain base64 array, no data URL prefix', async () => {
    const body = await sentBody(new OllamaAdapter(), 'ollama', visionTurn)
    expect(body.messages[0].images).toEqual([PNG])
  })

  it('responses: input_text + input_image parts', async () => {
    const body = await sentBody(new ResponsesAdapter(), 'responses', visionTurn)
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: '这张图里是什么？' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    ])
  })
})

describe('text-only requests keep their previous shape', () => {
  beforeEach(() => {
    llmFetchMock.mockReset()
  })

  const textTurn = [{ role: 'user' as const, content: 'hello' }]

  it('content stays a plain string when no image is attached', async () => {
    const openai = await sentBody(new OpenAIAdapter(), 'openai', textTurn)
    expect(openai.messages[0].content).toBe('hello')
    const anthropic = await sentBody(new AnthropicAdapter(), 'anthropic', textTurn)
    expect(anthropic.messages[0].content).toBe('hello')
    const ollama = await sentBody(new OllamaAdapter(), 'ollama', textTurn)
    expect(ollama.messages[0].images).toBeUndefined()
  })
})
