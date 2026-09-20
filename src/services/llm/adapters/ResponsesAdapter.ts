import { ApiConfigGroup, LLMRequest, LLMStreamChunk, LLMToolCall, normalizeReasoningEffort } from '@/types'
import { LLMAdapter } from '../types'
import { llmFetch } from '../http'
import { buildChatUrl, buildModelsUrl } from '../endpoints'
import { imageDataUrl } from './vision'

/**
 * OpenAI Responses API adapter — POST {base}/v1/responses.
 *
 * Translates the internal LLMRequest into the Responses "input items" format
 * (input_text / output_text / function_call / function_call_output) and parses
 * both the non-streaming response (output[] items) and the SSE stream
 * (response.output_text.delta, response.function_call_arguments.delta,
 * response.output_item.done, response.completed, ...).
 */
export class ResponsesAdapter implements LLMAdapter {
  async *sendRequest(req: LLMRequest, config: ApiConfigGroup, signal?: AbortSignal): AsyncGenerator<LLMStreamChunk> {
    const url = buildChatUrl(config.baseUrl, 'responses', req.model)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    }

    const body: Record<string, any> = {
      model: req.model,
      input: buildInputItems(req),
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.topP,
      frequency_penalty: req.frequencyPenalty,
      presence_penalty: req.presencePenalty,
    }

    if (req.maxTokens > 0) {
      body.max_output_tokens = req.maxTokens
    }

    // Tools use the same OpenAI function format as chat completions
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools
    }

    // Deep thinking: Responses API reasoning models use `reasoning: { effort }`
    if (req.thinking) {
      body.reasoning = { effort: normalizeReasoningEffort(req.reasoningEffort) }
    }

    const response = await llmFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { stream: true, skipTlsVerify: !!config.skipTlsVerify })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`API 请求失败 (${response.status}): ${errorText || response.statusText}`)
    }

    if (!req.stream) {
      const data = await response.json()
      const toolCalls = parseToolCalls(data.output)
      yield {
        content: parseOutputText(data.output),
        done: false,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.usage ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens } : undefined,
      }
      yield { content: '', done: true }
      return
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Tool calls accumulated from function_call_arguments.delta / output_item.done
    const toolCallsAcc: Map<string, { id: string; name: string; arguments: string }> = new Map()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            yield { content: '', done: true }
            return
          }

          let json: any
          try {
            json = JSON.parse(data)
          } catch {
            continue // Skip invalid JSON lines
          }

          const type = json.type

          // Streamed output text
          if (type === 'response.output_text.delta' && json.delta) {
            yield { content: json.delta, done: false }
          }

          // Reasoning tokens (o-series / reasoning models)
          if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && json.delta) {
            yield { content: '', thinking: json.delta, done: false }
          }

          // Tool call arguments arrive as incremental deltas per item
          if (type === 'response.function_call_arguments.delta' && json.delta) {
            const acc = getOrCreateToolCall(toolCallsAcc, json.item_id)
            acc.arguments += json.delta
          }

          // Final arguments snapshot for an item
          if (type === 'response.function_call_arguments.done' && json.item_id) {
            const acc = getOrCreateToolCall(toolCallsAcc, json.item_id)
            if (json.arguments) acc.arguments = json.arguments
          }

          // A completed output item — function_call items carry id/name/arguments
          if (type === 'response.output_item.done' && json.output?.type === 'function_call') {
            const item = json.output
            const acc = getOrCreateToolCall(toolCallsAcc, item.id || item.call_id || '')
            if (item.call_id || item.id) acc.id = item.call_id || item.id
            if (item.name) acc.name = item.name
            if (item.arguments) acc.arguments = item.arguments
          }

          // Stream finished
          if (type === 'response.completed') {
            const usage = json.response?.usage
            const toolCalls: LLMToolCall[] = Array.from(toolCallsAcc.values())
              .filter((tc) => tc.id && tc.name)
              .map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              }))
            if (toolCalls.length > 0) {
              yield {
                content: '',
                toolCalls,
                done: true,
                usage: usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } : undefined,
              }
            } else {
              yield {
                content: '',
                done: true,
                usage: usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } : undefined,
              }
            }
            return
          }

          // Provider-side error mid-stream
          if (type === 'error' || type === 'response.failed') {
            throw new Error(json.message || 'Responses API 流式请求失败')
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async fetchModels(config: ApiConfigGroup, signal?: AbortSignal): Promise<string[]> {
    const url = buildModelsUrl(config.baseUrl, 'responses')
    if (!url) return []
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    }

    const response = await llmFetch(url, { headers, signal }, { skipTlsVerify: !!config.skipTlsVerify })
    if (!response.ok) {
      throw new Error(`获取模型列表失败 (${response.status}): ${response.statusText}`)
    }

    const data = await response.json()
    return (data.data || []).map((m: any) => m.id).sort()
  }
}

/** Translate internal messages into Responses API input items. */
function buildInputItems(req: LLMRequest): any[] {
  const items: any[] = []
  for (const m of req.messages) {
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content,
      })
      continue
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: any[] = []
      if (m.content) {
        content.push({ type: 'output_text', text: m.content })
      }
      const item: any = { role: 'assistant' }
      if (content.length > 0) item.content = content
      if (Object.keys(item).length > 1) items.push(item)
      for (const tc of m.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })
      }
      continue
    }

    const parts: any[] = []
    // Vision: input_image parts take the data: URL form. An empty text part is
    // skipped only when images follow — a content-less item is rejected.
    if (m.content || !m.images?.length) {
      parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content })
    }
    if (m.role === 'user' && m.images?.length) {
      for (const img of m.images) parts.push({ type: 'input_image', image_url: imageDataUrl(img) })
    }
    items.push({
      role: m.role as 'system' | 'user' | 'assistant',
      content: parts,
    })
  }
  return items
}

/** Concatenate output_text blocks from non-streaming response output[]. */
function parseOutputText(output: any[]): string {
  let text = ''
  for (const item of output || []) {
    if (item.type !== 'message') continue
    for (const block of item.content || []) {
      if (block.type === 'output_text' && block.text) text += block.text
    }
  }
  return text
}

/** Extract function_call items from non-streaming response output[]. */
function parseToolCalls(output: any[]): LLMToolCall[] {
  const calls: LLMToolCall[] = []
  for (const item of output || []) {
    if (item.type !== 'function_call') continue
    calls.push({
      id: item.call_id || item.id,
      type: 'function' as const,
      function: { name: item.name, arguments: item.arguments },
    })
  }
  return calls
}

function getOrCreateToolCall(acc: Map<string, { id: string; name: string; arguments: string }>, key: string): { id: string; name: string; arguments: string } {
  const k = key || 'default'
  if (!acc.has(k)) {
    acc.set(k, { id: '', name: '', arguments: '' })
  }
  return acc.get(k)!
}
