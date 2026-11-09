/**
 * run 展开状态的持久化（每个 message id 一条，前缀 `ourcode.shell.run.`）。
 *
 * 为什么单独抽一层：localStorage 里的东西是用户手也能改的，历史版本还可能写过
 * 别的形状。任何一次 JSON.parse 直接抛异常都会把整个对话列打挂，所以这里的
 * parse 必须「坏数据 = 空表」，并且要挡住 __proto__ 这类键。
 */

/** 所有本切片的 localStorage key 都以它开头。 */
export const RUN_STORAGE_PREFIX = 'ourcode.shell.run.'

/** 步骤列表展开状态：{ [messageId]: boolean } */
export const RUN_EXPANSION_KEY = `${RUN_STORAGE_PREFIX}expanded`

/** 思考块展开状态：{ [messageId]: boolean } */
export const RUN_THINKING_KEY = `${RUN_STORAGE_PREFIX}thinking`

/** 一张展开表最多记多少条 message（防止 localStorage 无限增长）。 */
export const RUN_EXPANSION_LIMIT = 200

export type ExpansionMap = Record<string, boolean>

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 取一个可用的 Storage；拿不到（SSR / 隐私模式 / 被禁用）就返回 null。 */
export function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null
    return localStorage
  } catch {
    return null
  }
}

/**
 * 解析持久化的展开表。
 * - 非 JSON、非对象、数组、null → 空表
 * - 非布尔值逐条丢弃（不整表作废：一条脏数据不该清掉其他消息的记忆）
 * - __proto__ / constructor / prototype 一律忽略
 */
export function parseExpansionMap(raw: string | null | undefined): ExpansionMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: ExpansionMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || UNSAFE_KEYS.has(key)) continue
    if (typeof value !== 'boolean') continue
    out[key] = value
  }
  return out
}

/** 序列化回去（稳定输出，便于测试与人工排查）。 */
export function serializeExpansionMap(map: ExpansionMap): string {
  const ordered: ExpansionMap = {}
  for (const key of Object.keys(map)) {
    if (!key || UNSAFE_KEYS.has(key)) continue
    if (typeof map[key] !== 'boolean') continue
    ordered[key] = map[key]
  }
  return JSON.stringify(ordered)
}

/** 某条消息是否展开；没有记录时用 fallback（思考块「流式中默认展开」靠它）。 */
export function isExpanded(map: ExpansionMap, messageId: string, fallback = false): boolean {
  if (!messageId) return fallback
  const value = map[messageId]
  return typeof value === 'boolean' ? value : fallback
}

/** 写入一条展开状态，返回新表；超过上限时丢最早写入的记录。 */
export function withExpanded(
  map: ExpansionMap,
  messageId: string,
  expanded: boolean,
  limit = RUN_EXPANSION_LIMIT,
): ExpansionMap {
  if (!messageId || UNSAFE_KEYS.has(messageId)) return map
  const next: ExpansionMap = { ...map, [messageId]: expanded }
  const keys = Object.keys(next)
  const overflow = keys.length - Math.max(1, limit)
  if (overflow > 0) {
    for (const key of keys.slice(0, overflow)) delete next[key]
  }
  return next
}

/**
 * 读缓存：一条消息一个组件，挂载时都要问一次「我展开过吗」。
 * 同一次渲染里几十次 JSON.parse 没必要，用「原始字符串相同就复用」的缓存；
 * 写操作会直接更新缓存，所以不会读到旧值。
 */
const readCache = new Map<string, { raw: string | null; map: ExpansionMap }>()

/** 读一张表；storage 不可用或内容损坏都退化成空表。 */
export function readExpansionMap(
  key: string,
  storage: Pick<Storage, 'getItem'> | null = resolveStorage(),
): ExpansionMap {
  if (!storage) return {}
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return {}
  }
  const cached = readCache.get(key)
  if (cached && cached.raw === raw) return cached.map
  const map = parseExpansionMap(raw)
  readCache.set(key, { raw, map })
  return map
}

/** 写一张表；写失败（配额 / 隐私模式）静默忽略 —— 记不住展开状态不是致命错误。 */
export function writeExpansionMap(
  key: string,
  map: ExpansionMap,
  storage: Pick<Storage, 'setItem'> | null = resolveStorage(),
): void {
  if (!storage) return
  const raw = serializeExpansionMap(map)
  try {
    storage.setItem(key, raw)
    readCache.set(key, { raw, map })
  } catch {
    /* 忽略：持久化是锦上添花 */
  }
}
