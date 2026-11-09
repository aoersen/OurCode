/**
 * 模型浮层的纯逻辑：搜索过滤、可读名、能力行、收藏条、思考档位解析。
 *
 * 所有数据都来自真实配置（`ModelInfo` / `CustomModel`），绝不给模型编能力：
 *  - 上下文窗口：`model.contextWindow`（configStore 的 enrichModel 已经按
 *    自定义模型 → 精选表 → 厂商目录合并好），没有就整段省略；
 *  - 视觉 / 函数调用 / 免费：只有字段为 `true` 才出现（`false` 是「没这项能力」，
 *    逐个模型挂一行「无视觉」是噪音，不是信息）；
 *  - 思考档位：`getReasoningLevels`（自定义模型 reasoningLevels → 目录 → 全档），
 *    浮层只渲染它真的返回的档。
 */
import { ALL_REASONING_LEVELS, getReasoningLevels } from '@/services/llm/modelDefaults'
import { formatTokenCount } from '@/services/llm/contextUsage'
import type { CustomModel, ModelInfo, ThinkingLevel } from '@/types'
import { copyFor } from './copy'
import type { MenuLocale } from './locale'

/** 无 alias 时把模型 id 变回可读名：claude-sonnet-4-5 → Claude Sonnet 4.5 */
export function prettyModelId(id: string): string {
  const parts = id.split(/[-_/]+/).filter(Boolean)
  const words: string[] = []
  for (const raw of parts) {
    if (/^\d+$/.test(raw) && words.length > 0 && /(^|\.)\d+$/.test(words[words.length - 1])) {
      words[words.length - 1] += '.' + raw
      continue
    }
    words.push(/^\d/.test(raw) ? raw : raw.charAt(0).toUpperCase() + raw.slice(1))
  }
  return words.join(' ') || id
}

/** 行标题：alias 优先，其次可读化的 id。 */
export function modelName(model: Pick<ModelInfo, 'id' | 'alias'>): string {
  return model.alias?.trim() || prettyModelId(model.id)
}

/**
 * 搜索过滤：命中 id 或 alias 的任意子串（大小写不敏感，查询两端空白忽略）。
 * 空查询原样返回（保持 configStore 的顺序：收藏优先 + 字典序）。
 */
export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...models]
  return models.filter((m) => {
    if (m.id.toLowerCase().includes(q)) return true
    const alias = m.alias?.toLowerCase()
    return !!alias && alias.includes(q)
  })
}

/**
 * 能力行（12px muted）：只包含配置里真的给了的字段。
 * 例：`200K · 视觉 · 函数调用`；什么都没配时返回空数组（行只显示名字）。
 */
export function capabilityTags(
  model: Pick<ModelInfo, 'contextWindow' | 'vision' | 'functionCall' | 'isFree'>,
  locale: MenuLocale,
): string[] {
  const copy = copyFor(locale)
  const tags: string[] = []
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    tags.push(formatTokenCount(model.contextWindow))
  }
  if (model.vision === true) tags.push(copy.capabilityVision)
  if (model.functionCall === true) tags.push(copy.capabilityTools)
  if (model.isFree === true) tags.push(copy.capabilityFree)
  return tags
}

/** 收藏行：最多 4 个模型名，按 favoriteModelIds 的顺序，过滤掉列表里没有的 id。 */
export function favoriteNames(
  models: readonly ModelInfo[],
  favoriteIds: readonly string[],
  limit = 4,
): string[] {
  const byId = new Map(models.map((m) => [m.id, m]))
  const names: string[] = []
  for (const id of favoriteIds) {
    const hit = byId.get(id)
    if (!hit) continue
    const name = modelName(hit)
    if (!names.includes(name)) names.push(name)
    if (names.length >= limit) break
  }
  return names
}

/** 规范顺序（关 → 低 → 中 → 高 → 最高），去掉未知档与重复档。 */
export function sortThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const present = new Set(levels)
  return ALL_REASONING_LEVELS.filter((level) => present.has(level))
}

/**
 * 当前模型真正支持的思考档位。
 * `customModels` 显式传入（组件从 configStore 读），不传时 getReasoningLevels 会自己读 store。
 */
export function thinkingLevelsFor(modelId: string, customModels?: CustomModel[]): ThinkingLevel[] {
  if (!modelId) return [...ALL_REASONING_LEVELS]
  return sortThinkingLevels(getReasoningLevels(modelId, customModels))
}

const THINKING_LABELS: Record<ThinkingLevel, Record<MenuLocale, string>> = {
  off: { 'zh-CN': '关', 'en-US': 'Off' },
  low: { 'zh-CN': '低', 'en-US': 'Low' },
  medium: { 'zh-CN': '中', 'en-US': 'Med' },
  high: { 'zh-CN': '高', 'en-US': 'High' },
  max: { 'zh-CN': '最高', 'en-US': 'Max' },
}

export function thinkingLevelLabel(level: ThinkingLevel, locale: MenuLocale): string {
  return THINKING_LABELS[level]?.[locale] ?? THINKING_LABELS[level]?.['zh-CN'] ?? level
}

/**
 * ←/→ 在分段控件里移动：只在当前模型支持的档位之间走，到头就停（不回绕——
 * 从「最高」一下跳回「关」像是在关掉思考，容易误触）。
 */
export function stepThinkingLevel(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel,
  direction: 1 | -1,
): ThinkingLevel {
  if (levels.length === 0) return current
  const index = levels.indexOf(current)
  if (index < 0) return levels[0]
  const next = Math.min(levels.length - 1, Math.max(0, index + direction))
  return levels[next]
}

/** 分段控件要渲染的当前档：不在支持列表里时收敛到第一档（多为 'off'）。 */
export function effectiveThinkingLevel(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel,
): ThinkingLevel {
  return levels.length === 0 ? current : levels.includes(current) ? current : levels[0]
}
