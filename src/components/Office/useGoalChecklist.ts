/**
 * 目标达成区域共用数据 hook —— 5s 轮询兜底 + 事件触发即时刷新，active=false 停止。
 * GoalChecklistCard 与 OfficeTopBar（徽章达成率）共用，避免各自轮询。
 *
 * 返回两个数据源：
 * - summary：清单通过率（finalGoal + 最近一份 comparison.md，轮级验证口径）；
 * - status：实施进度（implementationStatus.md 的总体百分比/阶段，模型每阶段更新，
 *   执行期间目标达成卡上「会动」的数字来自这里）。
 *
 * 事件触发源两个：
 * - `ourcode:file-changed`：监督者/子智能体写盘 .ourcode/targemode/ 下文件时
 *   派发（300ms 去抖，把 multi_edit_file 等多文件写合并成一次读取）；
 * - `runningSessionIds`：目标会话从运行态退出时立即刷新一次（兜住收尾写盘
 *   未走工具、没触发文件事件的路径）。
 */
import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { readGoalChecklist, type GoalChecklistSummary } from '@/services/targetMode/goalChecklist'
import { readStatus, type TargetModeStatus } from '@/services/targetMode/targetModeService'

const REFRESH_DEBOUNCE_MS = 300
const POLL_INTERVAL_MS = 5000

/**
 * 路径是否落在 <root>/.ourcode/targemode 目录内（Windows 大小写/分隔符不敏感）。
 * 事件载荷是工具调用里模型写的原始路径——模型常写相对路径
 * （如 `.ourcode/targemode/loop1/comparison.md`），要按 root 解析后再比对。
 */
function isTargemodePath(root: string, path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const base = norm(root).replace(/\/+$/, '')
  const target = `${base}/.ourcode/targemode`
  const p = norm(path)
  if (p === target || p.startsWith(target + '/')) return true
  if (p.startsWith('/') || /^[a-z]:\//.test(p)) return false
  const resolved = `${base}/${p.replace(/^\.\//, '')}`
  return resolved === target || resolved.startsWith(target + '/')
}

export interface GoalChecklistLive {
  summary: GoalChecklistSummary | null
  status: TargetModeStatus | null
}

export function useGoalChecklist(
  root: string | null,
  active: boolean,
  sessionId?: string | null,
): GoalChecklistLive {
  const [summary, setSummary] = useState<GoalChecklistSummary | null>(null)
  const [status, setStatus] = useState<TargetModeStatus | null>(null)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)

  useEffect(() => {
    if (!root || !active) {
      setSummary(null)
      setStatus(null)
      return
    }
    let alive = true
    let debounceTimer: number | null = null
    const load = () => {
      Promise.all([readGoalChecklist(root), readStatus(root)]).then(([s, st]) => {
        if (!alive) return
        setSummary(s)
        setStatus(st)
      })
    }
    const scheduleRefresh = () => {
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(load, REFRESH_DEBOUNCE_MS)
    }
    load()

    // targemode 文件写盘 → 去抖刷新
    const onFileChanged = (e: Event) => {
      const path = (e as CustomEvent<string>).detail
      if (typeof path === 'string' && isTargemodePath(root, path)) scheduleRefresh()
    }
    window.addEventListener('ourcode:file-changed', onFileChanged)

    // 兜底轮询：模型直接手写文件不走工具（罕见）时仍能跟上
    const timer = window.setInterval(load, POLL_INTERVAL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
      if (debounceTimer != null) window.clearTimeout(debounceTimer)
      window.removeEventListener('ourcode:file-changed', onFileChanged)
    }
  }, [root, active])

  // 目标会话运行结束 → 立即刷新一次。员工续跑会让 runningSessionIds 先移除
  // 再立刻重入，多读一次文件无害。
  const prevRunningRef = useRef(runningSessionIds)
  useEffect(() => {
    const prev = prevRunningRef.current
    prevRunningRef.current = runningSessionIds
    if (!root || !active || !sessionId) return
    if (prev.includes(sessionId) && !runningSessionIds.includes(sessionId)) {
      let alive = true
      Promise.all([readGoalChecklist(root), readStatus(root)]).then(([s, st]) => {
        if (!alive) return
        setSummary(s)
        setStatus(st)
      })
      return () => {
        alive = false
      }
    }
  }, [runningSessionIds, root, active, sessionId])

  return { summary, status }
}
