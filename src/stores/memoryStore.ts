/**
 * Memory store — persistent user memories.
 *
 * Memories are stored in SQLite (main process, optionally encrypted) and are
 * injected into the system prompt by the chat store when they match the
 * current message. A small heuristic also auto-suggests a memory when the user
 * asks the assistant to "记住" something.
 */
import { create } from 'zustand'
import { Memory } from '@/types'
import { sendLLMRequest } from '@/services/llm/LLMClient'
import { useConfigStore } from './configStore'

interface MemoryState {
  memories: Memory[]
  loaded: boolean

  loadMemories: () => Promise<void>
  addMemory: (content: string, scope?: 'global' | 'project', projectPath?: string) => Promise<void>
  deleteMemory: (id: string) => Promise<void>
  getMemoriesByProject: (projectPath: string) => Memory[]
  getGlobalMemories: () => Memory[]
  getProjectPaths: () => string[]
  /** Ask the LLM to condense a conversation snippet into long-term memory
   *  (project-scoped). Throws on failure so the UI can surface the error.
   *  `model` is an optional hint — prefer the model the user is actually
   *  chatting with, falling back to the config group's default.
   *  `configGroupId` 应与 model 同源（会话自己的组）——用活动组会把会话组 B
   *  的模型名发到活动组 A 的端点 → 400 "Unsupported model"。
   *  Returns the condensed text WITHOUT writing it — the UI shows the result
   *  to the user for review/editing before `addMemory` is called. */
  condenseMemory: (conversation: string, projectPath: string, model?: string, configGroupId?: string) => Promise<string>
}

/** System prompt for the memory-condensation helper request */
const CONDENSE_SYSTEM_PROMPT = [
  '你是一个记忆浓缩助手。用户从对话中点选了「记住」，希望把这段对话沉淀为长期记忆。',
  '请把对话内容浓缩成 1~3 条精炼、具体、可长期复用的记忆（每条一行，用 - 开头）。',
  '重点提炼：用户的偏好、技术决策、项目约定、已确认的经验教训等。',
  '不要客套，不要重复对话中的废话，只输出记忆条目本身。',
].join('\n')

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  loaded: false,

  loadMemories: async () => {
    try {
      const memories = await window.electronAPI.memoryList()
      set({ memories, loaded: true })
    } catch (error) {
      console.error('加载记忆失败:', error)
      set({ loaded: true })
    }
  },

  addMemory: async (content, scope = 'global', projectPath) => {
    const trimmed = content.trim()
    if (!trimmed) return
    try {
      const memory = await window.electronAPI.memoryAdd(trimmed, scope, projectPath)
      set({ memories: [memory, ...get().memories] })
    } catch (error) {
      console.error('保存记忆失败:', error)
      // Rethrow so callers can surface the failure instead of claiming success.
      throw error
    }
  },

  deleteMemory: async (id) => {
    try {
      await window.electronAPI.memoryDelete(id)
      set({ memories: get().memories.filter((m) => m.id !== id) })
    } catch (error) {
      console.error('删除记忆失败:', error)
    }
  },

  getMemoriesByProject: (projectPath) => {
    return get().memories.filter((m) => m.scope === 'project' && m.projectPath === projectPath)
  },

  getGlobalMemories: () => {
    return get().memories.filter((m) => m.scope === 'global')
  },

  getProjectPaths: () => {
    const paths = new Set<string>()
    get().memories.forEach((m) => {
      if (m.scope === 'project' && m.projectPath) paths.add(m.projectPath)
    })
    return Array.from(paths).sort()
  },

  condenseMemory: async (conversation, projectPath, model, configGroupId) => {
    // 组与模型同源（会话自己的配置组优先），避免跨组错配 400。
    const group = useConfigStore.getState().getConfigGroupFor(configGroupId)
    if (!group) {
      throw new Error('尚未配置 API，无法浓缩记忆。请先在设置中添加 API 配置。')
    }
    const resolvedModel = (model || group.defaultModel || '').trim()
    if (!resolvedModel) {
      throw new Error('当前配置未设置默认模型，无法浓缩记忆。')
    }

    // Non-streaming condensation request (bounded output)
    let condensed = ''
    for await (const chunk of sendLLMRequest(
      {
        model: resolvedModel,
        messages: [
          { role: 'system', content: CONDENSE_SYSTEM_PROMPT },
          { role: 'user', content: conversation },
        ],
        stream: false,
        temperature: 0,
        maxTokens: 800,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
      },
      group,
      60_000,
    )) {
      if (chunk.content) condensed += chunk.content
      if (chunk.done) break
    }

    const trimmed = condensed.trim()
    if (!trimmed) {
      throw new Error('AI 未返回有效记忆内容，请重试')
    }
    return trimmed
  },
}))
