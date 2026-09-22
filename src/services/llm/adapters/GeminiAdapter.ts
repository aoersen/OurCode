import { ApiConfigGroup, LLMRequest, LLMStreamChunk } from '@/types'
import { LLMAdapter } from '../types'
import { llmFetch } from '../http'
import { buildChatUrl, buildModelsUrl } from '../endpoints'

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
]

export class GeminiAdapter implements LLMAdapter {
  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const stream = req.stream ? 'streamGenerateContent' : 'generateContent'
    const url = `${buildChatUrl(config.baseUrl, 'gemini', req.model).replace(':generateContent', `:${stream}`)}?key=${config.apiKey}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.customHeaders,
    }

    // Convert messages to Gemini format
    // Join all system messages into a single system instruction
    const systemMessages = req.messages.filter((m) => m.role === 'system')
    const systemInstruction = systemMessages.length > 0
      ? { parts: systemMessages.map((m) => ({ text: m.content })) }
      : undefined

    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const parts: Array<Record<string, any>> = [{ text: m.content || '' }]
        // Vision: inline base64 image parts on user turns.
        if (m.role === 'user' && m.images?.length) {
          for (const img of m.images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } })
          }
        }
        // Preserve tool calls in assistant messages
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            let parsedArgs: Record<string, any> = {}
            try { parsedArgs = JSON.parse(tc.function.arguments) } catch { /* keep empty */ }
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: parsedArgs,
              },
            })
          }
        }
        // Preserve tool result in tool messages
        if (m.role === 'tool' && m.toolCallId) {
          parts.push({
            functionResponse: {
              name: m.toolCallId,
              response: { result: m.content },
            },
          })
        }
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts,
        }
      })

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: req.temperature,
        topP: req.topP,
        maxOutputTokens: req.maxTokens > 0 ? req.maxTokens : undefined,
      },
    }

    // Deep thinking: Gemini reasoning models use thinkingConfig.thinkingBudget
    // (low/medium/high/max -> 2048/4096/8192/16384 tokens). A budget > 0 enables
    // thinking.
    if (req.thinking) {
      const effortBudgets = { low: 2048, medium: 4096, high: 8192, max: 16384 }
      body.generationConfig.thinkingConfig = { thinkingBudget: effortBudgets[req.reasoningEffort || 'high'] }
    }

    if (systemInstruction) {
      body.systemInstruction = systemInstruction
    }

    // Add tools if provided (Gemini uses its own tool format)
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        functionDeclarations: [{ name: t.function.name, description: t.function.description, parameters: t.function.parameters }],
      }))
    }

    const response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Gemini API 请求失败 (${response.status}): ${errorText || response.statusText}`)
    }

    if (!req.stream) {
      const data = await response.json()
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const usage = data.usageMetadata
      yield {
        content,
        done: false,
        usage: usage ? { promptTokens: usage.promptTokenCount || 0, completionTokens: usage.candidatesTokenCount || 0 } : undefined,
      }
      yield { content: '', done: true }
      return
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // Gemini's streamGenerateContent returns one complete JSON object per
          // line (no SSE `data:` prefix). The old regex /\{"candidates":\[.*?\]\}/
          // matched every chunk EXCEPT the final one — which appends
          // "usageMetadata":{...} after the candidates array, so `]}` never
          // occurs and the whole chunk (usage + possibly the last text delta)
          // was silently dropped. Parse the full line instead.
          const json = tryParseLine(trimmed)
          if (!json) continue
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text
          const usage = json.usageMetadata

          if (text) {
            yield {
              content: text,
              done: false,
              usage: usage ? { promptTokens: usage.promptTokenCount || 0, completionTokens: usage.candidatesTokenCount || 0 } : undefined,
            }
          } else if (usage) {
            // The final chunk may carry usage with no text — surface it so the
            // dashboard's token counts are real instead of 0.
            yield {
              content: '',
              done: false,
              usage: { promptTokens: usage.promptTokenCount || 0, completionTokens: usage.candidatesTokenCount || 0 },
            }
          }
        }
      }

      yield { content: '', done: true }
    } finally {
      reader.releaseLock()
    }
  }

  async fetchModels(config: ApiConfigGroup, signal?: AbortSignal): Promise<string[]> {
    try {
      const url = `${buildModelsUrl(config.baseUrl, 'gemini')}?key=${config.apiKey}`
      const response = await llmFetch(url, { signal }, { skipTlsVerify: !!config.skipTlsVerify })
      if (!response.ok) {
        throw new Error(`获取模型列表失败 (${response.status})`)
      }
      const data = await response.json()
      const models = (data.models || [])
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => m.name.replace('models/', ''))
        .sort()
      return models.length > 0 ? models : GEMINI_MODELS
    } catch {
      return GEMINI_MODELS
    }
  }
}

/**
 * Parse a Gemini stream line into a JSON object. The line is one complete
 * `{ candidates, usageMetadata }` object; some gateways additionally wrap it
 * in SSE (`data: ` prefix) or an array (`[{...}]`), so strip those first.
 * Returns null on malformed JSON (skipped, never throws).
 */
function tryParseLine(line: string): any {
  try {
    let s = line
    if (s.startsWith('data:')) s = s.slice(5)
    s = s.trim()
    // `[{...}]` array wrapper from some relay gateways
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim()
    if (!s) return null
    return JSON.parse(s)
  } catch {
    return null
  }
}
