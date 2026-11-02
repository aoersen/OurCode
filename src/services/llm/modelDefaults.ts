/**
 * Effective per-model request defaults.
 *
 * Priority is always: user model config (Settings → 模型配置) → curated policy
 * table in shared/constants.ts → generated vendor catalog → hard default.
 * Keeping this in one place makes the settings UI, history trimming, compaction
 * and the request builder agree on the same window/output numbers.
 */
import { lookupModelMetadata } from '@shared/constants'
import { getCatalogModel, type ReasoningLevel } from '@shared/modelCatalog'
import type { CustomModel } from '@/types'
import { useConfigStore } from '@/stores/configStore'

/** Fallback context window when nothing else is known (tokens). */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Every thinking level the app can send when no model metadata restricts it. */
export const ALL_REASONING_LEVELS: ReasoningLevel[] = ['off', 'low', 'medium', 'high', 'max']

function findInList(modelId: string, list: CustomModel[]): CustomModel | undefined {
  const exact = list.find((m) => m.id === modelId)
  if (exact) return exact
  // Session models may carry a gateway prefix (`openai/gpt-4o`) while the
  // saved model config is keyed by the bare id.
  const bare = modelId.split('/').pop() || modelId
  return bare === modelId ? undefined : list.find((m) => m.id === bare)
}

function findCustomModel(modelId: string) {
  return findInList(modelId, useConfigStore.getState().customModels)
}

/** Context window if anything knows it (no 128K fallback). */
export function getKnownContextWindow(modelId: string, customModels?: CustomModel[]): number | undefined {
  const custom = customModels ? findInList(modelId, customModels) : findCustomModel(modelId)
  return custom?.contextWindow
    || lookupModelMetadata(modelId)?.contextWindow
    || getCatalogModel(modelId)?.contextWindow
    || undefined
}

/** Context window used for budgeting, trimming and compaction. */
export function getContextWindow(modelId: string, customModels?: CustomModel[]): number {
  return getKnownContextWindow(modelId, customModels) ?? DEFAULT_CONTEXT_WINDOW
}

/** Thinking levels the model supports, for filtering the chat level menu. */
export function getReasoningLevels(modelId: string, customModels?: CustomModel[]): ReasoningLevel[] {
  const custom = customModels ? findInList(modelId, customModels) : findCustomModel(modelId)
  const levels = custom?.reasoningLevels?.length
    ? custom.reasoningLevels
    : getCatalogModel(modelId)?.reasoningLevels
  return levels && levels.length > 0 ? levels : ALL_REASONING_LEVELS
}

/** Max output tokens the user saved for this model (undefined = provider default). */
export function getConfiguredMaxOutputTokens(modelId: string): number | undefined {
  const value = findCustomModel(modelId)?.maxOutputTokens
  return value && value > 0 ? value : undefined
}

/**
 * Effective max_tokens for a chat request: a non-zero per-session value wins,
 * then the per-model config. 0 keeps the provider's own default.
 */
export function resolveRequestMaxTokens(modelId: string, sessionMaxTokens: number): number {
  if (sessionMaxTokens > 0) return sessionMaxTokens
  return getConfiguredMaxOutputTokens(modelId) ?? 0
}

/**
 * Extra request-body fields for the current thinking level, from the model
 * config's reasoning mapping JSON. `disabled` is accepted as an alias for `off`
 * because provider docs usually spell the state that way.
 */
export function getReasoningParamMap(
  modelId: string,
  level: string,
): Record<string, unknown> | undefined {
  const raw = findCustomModel(modelId)?.reasoningParamMap
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const map = parsed as Record<string, unknown>
    const key = level === 'off' && map.disabled !== undefined ? 'disabled' : level
    const value = map[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}
