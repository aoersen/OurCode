/**
 * 产物面板「变更」时间线的纯计算层。
 *
 * 这里刻意不碰 store / DOM / window：面板只有拿到「+X −Y · M 个文件 · 耗时」
 * 和每一行的时间/类型文案才画得出来，而这些全部可以从 Checkpoint 列表 + 当前
 * 磁盘内容推出来。把推导抽成纯函数，便于单元测试（node 环境，无 jsdom）。
 *
 * 口径说明（重要）：
 *  一个 Checkpoint 的 `files[].content` 是**写入前**的快照。所以「这一笔写入
 *  改了多少行」= diff(本笔快照, 同一路径的下一笔快照) —— 最后一笔才用磁盘上的
 *  当前内容。这样同一文件被写多次时我们得到的是每一笔的真实增量，而不是每一笔
 *  都对「当前磁盘内容」算一遍（那样会重复计数）。
 */
import type { AgentRun, Checkpoint } from '@/types'

export interface LineCounts {
  added: number
  removed: number
}

export interface CheckpointTotals {
  /** 写入笔数 = checkpoint 条数 */
  writes: number
  /** 涉及的不重复文件数 */
  files: number
  added: number
  removed: number
}

export interface CheckpointStatsResult {
  byId: Map<string, LineCounts>
  totals: CheckpointTotals
}

/** 逐行 LCS 的 DP 上限：超过就走「整块替换」的粗略口径，避免面板卡住。 */
const LCS_CELL_LIMIT = 250_000

/** 按行切分。末尾换行只是结束符，不算一个空行。 */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const width = b.length + 1
  let prev = new Int32Array(width)
  let next = new Int32Array(width)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      next[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], next[j - 1])
    }
    const swap = prev
    prev = next
    next = swap
    next.fill(0)
  }
  return prev[b.length]
}

/**
 * 计算一段文本替换的新增/删除行数。
 * 先剥掉公共前缀/后缀（绝大多数编辑都是局部的），再对中间块求 LCS。
 */
export function lineDiffCounts(original: string, modified: string): LineCounts {
  const a = splitLines(original)
  const b = splitLines(modified)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }

  const middleA = a.slice(start, endA + 1)
  const middleB = b.slice(start, endB + 1)

  if (middleA.length === 0 && middleB.length === 0) return { added: 0, removed: 0 }
  if (middleA.length === 0) return { added: middleB.length, removed: 0 }
  if (middleB.length === 0) return { added: 0, removed: middleA.length }
  // 大块改写：跳过 LCS，按「整块换掉」计。数字略高但不会把界面锁住。
  if (middleA.length * middleB.length > LCS_CELL_LIMIT) {
    return { added: middleB.length, removed: middleA.length }
  }

  const lcs = lcsLength(middleA, middleB)
  return { added: middleB.length - lcs, removed: middleA.length - lcs }
}

/**
 * 逐笔统计写入增量。
 *
 * @param checkpoints      当前会话的 checkpoint 列表（顺序随意，内部按 createdAt 排）
 * @param currentContent   路径 → 当前磁盘内容；`null` 表示文件已不存在。
 *                         路径**不在 map 里**表示「当前状态未知」——该文件这一笔
 *                         跳过统计，而不是当成被删空（否则回退数字会虚高）。
 */
export function computeCheckpointStats(
  checkpoints: readonly Checkpoint[],
  currentContent: ReadonlyMap<string, string | null>
): CheckpointStatsResult {
  const ordered = orderCheckpoints(checkpoints)

  const byId = new Map<string, LineCounts>()
  for (const cp of ordered) byId.set(cp.id, { added: 0, removed: 0 })

  // path → 按时间升序的快照序列
  const history = new Map<string, Array<{ index: number; content: string }>>()
  const paths = new Set<string>()
  ordered.forEach((cp, index) => {
    for (const file of cp.files ?? []) {
      // 读取失败的前像（锁定/权限）不可信，既不算文件数也不算行数
      if (file.snapshotFailed) continue
      paths.add(file.path)
      const list = history.get(file.path) ?? []
      list.push({ index, content: file.existed ? file.content : '' })
      history.set(file.path, list)
    }
  })

  ordered.forEach((cp, index) => {
    const acc = byId.get(cp.id)
    if (!acc) return
    for (const file of cp.files ?? []) {
      if (file.snapshotFailed) continue
      const list = history.get(file.path) ?? []
      const next = list.find((entry) => entry.index > index)

      let nextContent: string
      if (next) {
        nextContent = next.content
      } else if (currentContent.has(file.path)) {
        nextContent = currentContent.get(file.path) ?? ''
      } else {
        continue
      }

      const counts = lineDiffCounts(file.existed ? file.content : '', nextContent)
      acc.added += counts.added
      acc.removed += counts.removed
    }
  })

  let added = 0
  let removed = 0
  for (const counts of byId.values()) {
    added += counts.added
    removed += counts.removed
  }

  return {
    byId,
    totals: { writes: ordered.length, files: paths.size, added, removed },
  }
}

/** 按 createdAt 升序（同一毫秒内保持入参顺序，避免行序在流式运行中乱跳）。 */
export function orderCheckpoints<T extends Checkpoint>(checkpoints: readonly T[]): T[] {
  return checkpoints
    .map((cp, index) => ({ cp, index }))
    .sort((a, b) => a.cp.createdAt - b.cp.createdAt || a.index - b.index)
    .map((entry) => entry.cp)
}

/** 「1m42s」/「42s」/「480ms」/「1h2m」。无效值返回 null（调用方自行决定隐藏）。 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${rest}m` : `${hours}h`
}

/** 本地 24 小时制 `14:28:10`。 */
export function formatClock(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** checkpoint.label 形如 `edit_file → src/foo.ts`，取出工具名。 */
export function checkpointToolName(label: string | undefined): string {
  const raw = label ?? ''
  const arrow = raw.indexOf('→')
  return (arrow >= 0 ? raw.slice(0, arrow) : raw).trim()
}

/** 第二行的类型文案（设计稿里的「新建文件」「改写 3 处」）。 */
export function checkpointKindLabel(checkpoint: Checkpoint): string {
  const tool = checkpointToolName(checkpoint.label)
  const files = (checkpoint.files ?? []).filter((f) => !f.snapshotFailed)
  const count = files.length
  switch (tool) {
    case 'write_file':
      return count > 0 && files.every((f) => !f.existed) ? '新建文件' : '写出文件'
    case 'edit_file':
    case 'multi_edit_file':
      return count > 1 ? `改写 ${count} 个文件` : '改写文件'
    case 'delete_file':
      return count > 1 ? `删除 ${count} 个文件` : '删除文件'
    case 'create_directory':
      return '新建目录'
    default:
      return tool || '写入'
  }
}

/**
 * 本次运行的耗时：优先用最近一次 run 的 startedAt→finishedAt，没有 run 记录时
 * 退回第一笔到最后一笔写入的时间跨度。
 */
export function runDurationMs(
  runs: readonly AgentRun[] | undefined | null,
  checkpoints: readonly Checkpoint[],
  now: number = Date.now()
): number | null {
  if (runs && runs.length > 0) {
    const latest = runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
    if (Number.isFinite(latest.startedAt)) {
      const end = typeof latest.finishedAt === 'number' ? latest.finishedAt : now
      if (end >= latest.startedAt) return end - latest.startedAt
    }
  }
  if (checkpoints.length > 1) {
    const times = checkpoints.map((cp) => cp.createdAt).filter((t) => Number.isFinite(t))
    if (times.length > 1) return Math.max(...times) - Math.min(...times)
  }
  return null
}

/** 设计稿头行的数据：`本次运行 N 次写入` + `+X −Y · M 个文件 · 耗时`。 */
export function summaryLine(totals: CheckpointTotals, duration: string | null): string {
  const parts = [`+${totals.added}`, `−${totals.removed}`, `${totals.files} 个文件`]
  if (duration) parts.push(duration)
  return parts.join(' · ')
}
