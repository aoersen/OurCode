import { ApiConfigGroup, LLMRequest, LLMStreamChunk, LLMToolCall } from '@/types'
import { LLMAdapter } from '../types'
import { llmFetch } from '../http'
import { buildChatUrl, buildModelsUrl } from '../endpoints'

/**
 * Normalize Ollama's tool_calls (arguments is an OBJECT, unlike OpenAI's JSON
 * string) into the LLMToolCall wire format used across adapters.
 */
function toLlmToolCalls(raw: Array<{ function?: { name?: string; arguments?: unknown } }> | undefined): LLMToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: LLMToolCall[] = []
  for (const tc of raw) {
    const fn = tc?.function
    const name = fn?.name
    if (!name) continue
    const args = fn.arguments
    calls.push({
      id: `call_${name}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    })
  }
  return calls
}

export class OllamaAdapter implements LLMAdapter {
  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const url = buildChatUrl(config.baseUrl, 'ollama')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.customHeaders,
    }

    const body: Record<string, any> = {
      model: req.model,
      messages: req.messages.map((m) => {
        const msg: Record<string, any> = { role: m.role, content: m.content }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }))
        }
        if (m.role === 'tool' && m.toolCallId) {
          msg.tool_call_id = m.toolCallId
        }
        // Vision: Ollama takes a plain base64 array on the message (no data: URL).
        if (m.role === 'user' && m.images?.length) {
          msg.images = m.images.map((img) => img.dataBase64)
        }
        return msg
      }),
      stream: req.stream,
      options: {
        temperature: req.temperature,
        top_p: req.topP,
        frequency_penalty: req.frequencyPenalty,
        presence_penalty: req.presencePenalty,
        num_predict: req.maxTokens > 0 ? req.maxTokens : undefined,
      },
    }
    // Add tools if provided (Ollama uses OpenAI-compatible tool format)
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools
    }

    const response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Ollama API 请求失败 (${response.status}): ${errorText || response.statusText}`)
    }

    if (!req.stream) {
      const data = await response.json()
      const toolCalls = toLlmToolCalls(data.message?.tool_calls)
      yield {
        content: data.message?.content || '',
        done: false,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.prompt_eval_count ? { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count } : undefined,
      }
      yield { content: '', done: true }
      return
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Ollama streams tool calls as message.tool_calls on (usually) the final
    // chunk — accumulate across chunks and emit on done, like the text path.
    let toolCallsAcc: LLMToolCall[] = []

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

          try {
            const json = JSON.parse(trimmed)
            const content = json.message?.content || ''
            const isDone = json.done === true
            const chunkCalls = toLlmToolCalls(json.message?.tool_calls)
            if (chunkCalls.length > 0) toolCallsAcc = chunkCalls

            if (content) {
              yield {
                content,
                done: false,
                usage: isDone && json.prompt_eval_count
                  ? { promptTokens: json.prompt_eval_count, completionTokens: json.eval_count }
                  : undefined,
              }
            }

            if (isDone) {
              yield {
                content: '',
                done: true,
                toolCalls: toolCallsAcc.length > 0 ? toolCallsAcc : undefined,
                usage: json.prompt_eval_count
                  ? { promptTokens: json.prompt_eval_count, completionTokens: json.eval_count }
                  : undefined,
              }
              return
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async fetchModels(config: ApiConfigGroup, signal?: AbortSignal): Promise<string[]> {
    const url = buildModelsUrl(config.baseUrl, 'ollama')
    if (!url) return []
    const response = await llmFetch(url, { signal }, { skipTlsVerify: !!config.skipTlsVerify })
    if (!response.ok) {
      throw new Error(`获取 Ollama 模型列表失败 (${response.status})`)
    }
    const data = await response.json()
    return (data.models || []).map((m: any) => m.name).sort()
  }
}
