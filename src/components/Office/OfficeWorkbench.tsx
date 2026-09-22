/**
 * 中央「实时工作台」（V12 审查 #1 + 后续审查）：对话流 / 任务流 / 代码变更 /
 * 终端 四页签。
 *
 * 数据全部来自 chatStore.subagentProgress（父 run_subagent toolCallId 键），
 * 无演示兜底。对话页签承载原右下对话流（OfficeStream）+ 内嵌决策区。
 *
 * 「任务流」页签（原「工具调用流」）：本会话内**所有角色**的子任务按启动时间
 * 排成一条时间线——每个节点是该角色的一次派发（角色头像/标签、任务摘要、
 * 状态），节点内折叠展示其工具步骤。代码变更 / 终端 同样取全会话（所有角色）
 * 的数据，不再依赖「选中角色」——此前被 `!selectedRole || !latest` 门控、
 * 且只取该角色最近一次 run，选中角色的最新 run 尚无写/命令步骤（或根本
 * 没选角色）时，切过去就是一片空白。
 */
import { useMemo, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { useThrottledValue } from '@/utils/useThrottledValue'
import { MONO, TASK_5STATE, GRADIENT, roleAvatar } from './officeTheme'
import { roleLabel, summarizeTask } from '@/services/office/mapping'
import OfficeStream from './OfficeStream'
import InlineDecisionArea from '../ChatPanel/InlineDecisionArea'
import type { SubAgentProgress, SubAgentProgressStep } from '@shared/types'

type Tab = 'chat' | 'tools' | 'changes' | 'term'

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file'])
const CMD_TOOLS = new Set(['run_command'])

function fileOf(args: Record<string, any>): string {
  if (typeof args.path === 'string') return args.path
  if (Array.isArray(args.edits) && args.edits[0]?.path) return args.edits[0].path
  return ''
}

function shortFile(path: string): string {
  return path.split(/[\\/]/).slice(-2).join('/')
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** HH:MM 紧凑时间戳（任务流节点）。 */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 运行中任务的耗时（mm:ss / h:mm:ss）。 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 步骤参数的一行可读摘要（去掉写文件的大段内容，只留路径等关键字段）。 */
function summarizeArgs(args: Record<string, any>): string {
  if (!args) return ''
  if (typeof args.path === 'string') return args.path.split(/[\\/]/).pop() || args.path
  if (typeof args.command === 'string') return args.command
  if (typeof args.oldText === 'string') return `"${truncate(args.oldText.replace(/\s+/g, ' '), 30)}" → "${truncate(String(args.newText ?? '').replace(/\s+/g, ' '), 30)}"`
  try {
    const s = JSON.stringify(args)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  } catch {
    return ''
  }
}

export default function OfficeWorkbench() {
  const t = useI18n()
  const [tab, setTab] = useState<Tab>('chat')
  // 任务流节点的展开态覆盖（父 run_subagent toolCallId → 是否展开）。未登记的
  // 节点按「运行中展开、已结束折叠」取默认，两个方向都能手动翻转。
  const [nodeOpen, setNodeOpen] = useState<Record<string, boolean>>({})
  const selectedRole = useUIStore((s) => s.officeSelectedRole)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // 进度表逐次推送高频换引用，500ms 节流避免整块工作台每秒重渲多次
  const subagentProgress = useThrottledValue(useChatStore((s) => s.subagentProgress), 500)

  // 本会话的全部子任务（所有角色）——三个数据页签共用，不再受角色选择门控。
  // 保留父 run_subagent 的 toolCallId 作为稳定 key（时间线节点/列表行复用）。
  const runs = useMemo(() => {
    if (!activeSessionId) return []
    return Object.entries(subagentProgress)
      .filter(([, p]) => p.sessionId === activeSessionId)
      .map(([key, p]) => ({ key, ...p }))
      .sort((a, b) => b.startedAt - a.startedAt)
  }, [subagentProgress, activeSessionId])

  /** 时间线顺序：按启动时间正序。 */
  const chronological = useMemo(() => [...runs].sort((a, b) => a.startedAt - b.startedAt), [runs])

  const latest: SubAgentProgress | undefined = runs[0]

  // 顶栏状态 meta：优先展示选中角色（若有记录），否则展示全会话聚合
  const selectedRoleRuns = useMemo(
    () => (selectedRole ? runs.filter((p) => roleLabel(p.task, p.name) === selectedRole) : []),
    [runs, selectedRole],
  )
  const metaRun = selectedRoleRuns[0] ?? latest
  const runningCount = runs.filter((p) => p.status === 'running').length
  const totalCalls = runs.reduce((sum, p) => sum + p.toolCallCount, 0)

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'chat', label: t('office.wbChat') },
    { id: 'tools', label: t('office.wbTools') },
    { id: 'changes', label: t('office.wbChanges') },
    { id: 'term', label: t('office.wbTerm') },
  ]

  const empty = (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-[280px]" style={{ color: MONO.t3, fontSize: 12, lineHeight: 1.8 }}>
        {activeSessionId ? t('office.wbNoRun') : t('office.wbNoSelect')}
      </div>
    </div>
  )

  const stateMeta = metaRun
    ? TASK_5STATE[metaRun.status === 'done' ? 'done' : metaRun.status === 'error' || metaRun.status === 'stopped' ? 'failed' : 'running']
    : null

  /** 单条工具步骤行（任务流节点内折叠区 / 代码变更 / 终端共用）。 */
  const renderStep = (s: SubAgentProgressStep, run: SubAgentProgress) => {
    const live = run.status === 'running' && s.status === 'running'
    const color = s.status === 'success' ? '#16A34A' : s.status === 'error' ? '#DC2626' : live ? '#0058BC' : '#9CA3AF'
    const icon = s.status === 'success' ? '✓' : s.status === 'error' ? '✕' : live ? '⚙' : '—'
    return (
      <div key={s.id} className="flex items-start gap-2 py-1">
        <span
          className="inline-flex items-center justify-center rounded flex-none"
          style={{
            width: 16, height: 16, fontSize: 10, marginTop: 2,
            color,
            background: s.status === 'success' ? 'rgba(22,163,74,0.1)' : s.status === 'error' ? 'rgba(220,38,38,0.08)' : live ? 'rgba(0,88,188,0.08)' : 'rgba(148,163,184,0.12)',
          }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs shrink-0" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t1 }}>
              {s.name}
            </span>
            <span className="text-xs truncate flex-1" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t3 }}>
              {summarizeArgs(s.arguments)}
            </span>
          </div>
          {s.result && (
            <div className="text-xs mt-0.5 truncate" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t2 }}>
              {truncate(s.result.replace(/\s+/g, ' '), 140)}
            </div>
          )}
        </div>
      </div>
    )
  }

  /** 任务流节点：一个角色的一次派发（含内部工具步骤）。 */
  const renderTimelineNode = (p: SubAgentProgress & { key: string }) => {
    const label = roleLabel(p.task, p.name)
    const avatar = roleAvatar(label)
    const live = p.status === 'running'
    const statusColor = live ? '#0058BC' : p.status === 'done' ? '#16A34A' : p.status === 'stopped' ? '#D97706' : '#DC2626'
    const statusText = live ? 'RUNNING' : p.status === 'done' ? 'DONE' : p.status === 'stopped' ? 'STOPPED' : 'FAILED'
    return (
      <div className="flex gap-2.5" key={p.key}>
        <div className="w-12 text-right shrink-0 pt-0.5">
          <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", fontSize: 10, color: MONO.t3 }}>
            {fmtTime(p.startedAt)}
          </span>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <span
            className="rounded-full flex items-center justify-center"
            style={{ width: 22, height: 22, background: avatar.bg, color: '#fff', fontSize: 10, fontWeight: 700, zIndex: 1 }}
          >
            {avatar.char}
          </span>
          <span className="flex-1" style={{ width: 1, background: 'rgba(15,23,42,0.08)', marginTop: 3 }} />
        </div>
        <div className="flex-1 min-w-0 pb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold shrink-0" style={{ color: MONO.t1 }}>{label}</span>
            <span
              className="shrink-0 rounded-full"
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                fontSize: 8.5, fontWeight: 700, letterSpacing: '0.04em',
                color: statusColor, background: `${statusColor}14`, padding: '1px 7px',
              }}
            >
              {statusText}{live && ` ${formatDuration(Date.now() - p.startedAt)}`}
            </span>
            {live && (
              <span
                className="shrink-0 rounded-full animate-spin"
                style={{ width: 12, height: 12, padding: 1.5, background: GRADIENT.rainbow, animationDuration: '2s' }}
              >
                <span className="block w-full h-full rounded-full" style={{ background: '#fff' }} />
              </span>
            )}
          </div>
          <div className="text-xs mt-0.5 truncate" style={{ color: MONO.t2 }} title={p.task}>
            {summarizeTask(p.task, 80)}
          </div>
          {p.error && (
            <div className="text-[11px] mt-0.5 break-words" style={{ color: '#DC2626' }}>{truncate(p.error, 200)}</div>
          )}
          {/* 步骤默认折叠：一个角色动辄 10+ 步，全展开就把「谁在什么时候干了
              什么」的时间线压成一堵工具日志墙。运行中的节点自动展开（要看实时
              进展），已结束的点开才看细节。 */}
          {p.steps.length > 0 && (() => {
            const open = nodeOpen[p.key] ?? live
            const last = p.steps[p.steps.length - 1]
            const lastArg = summarizeArgs(last.arguments)
            const lastLabel = lastArg ? `${last.name} ${lastArg}` : last.name
            return (
              <div className="mt-1.5 min-w-0">
                <button
                  onClick={() => setNodeOpen((prev) => ({ ...prev, [p.key]: !open }))}
                  className="flex items-center gap-1.5 max-w-full transition-colors hover:text-[#111827]"
                  style={{
                    fontSize: 10.5, color: MONO.t3, background: 'transparent',
                    border: 'none', cursor: 'pointer', padding: 0,
                  }}
                  title={open ? t('office.wbStepsCollapse') : t('office.wbStepsExpand')}
                >
                  <span className="shrink-0">{open ? '▾' : '▸'}</span>
                  <span className="shrink-0">{t('office.wbStepCount', { n: p.steps.length })}</span>
                  {!open && (
                    <span className="truncate" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace" }}>
                      · {lastLabel}
                    </span>
                  )}
                </button>
                {open && (
                  <div className="rounded-md px-2.5 py-1" style={{ background: 'rgba(15,23,42,0.02)', border: '1px solid rgba(15,23,42,0.05)' }}>
                    {p.steps.map((s) => renderStep(s, p))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="office-workbench"
      className="flex flex-col flex-1 min-h-0 rounded-xl border overflow-hidden"
      style={{ background: '#fff', borderColor: 'rgba(15,23,42,0.08)' }}
    >
      {/* 页签条 */}
      <div
        className="shrink-0 flex items-center px-3"
        style={{ height: 38, borderBottom: `1px solid ${MONO.hairline}`, gap: 2 }}
      >
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className="px-2.5 transition-colors"
            style={{
              height: '100%', marginBottom: -1, fontSize: 12.5,
              fontWeight: tab === tb.id ? 600 : 400,
              color: tab === tb.id ? '#0058BC' : MONO.t2,
              borderBottom: `2px solid ${tab === tb.id ? '#0058BC' : 'transparent'}`,
              cursor: 'pointer',
            }}
          >
            {tb.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2.5 shrink-0">
          {metaRun && stateMeta ? (
            <>
              <span className="flex items-center gap-1.5" style={{ fontSize: 12, color: MONO.t2 }}>
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: stateMeta.dot }} />
                {selectedRoleRuns.length > 0
                  ? `${selectedRole} · ${metaRun.status === 'running' ? t('office.running') : metaRun.status === 'done' ? t('office.taskDone') : metaRun.status === 'stopped' ? t('office.wbStopped') : t('office.taskFailed')}`
                  : t('office.wbRoleStats', { tasks: runs.length, running: runningCount, calls: totalCalls })}
              </span>
              <span className="text-xs" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t3 }}>
                {t('office.tokensUsed')} {Math.round(metaRun.tokenCount / 1000)}k · {metaRun.toolCallCount} {t('office.toolCalls')}
              </span>
            </>
          ) : (
            runs.length > 0 && (
              <span className="text-xs" style={{ color: MONO.t3 }}>
                {t('office.wbRoleStats', { tasks: runs.length, running: runningCount, calls: totalCalls })}
              </span>
            )
          )}
        </div>
      </div>

      {/* 内容区：对话页签 = 对话流主现场，恒显示。其余三个页签取全会话数据，
          不再依赖角色选择——有任务就有内容，没任务才显示空态。 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'chat' ? (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <OfficeStream />
            </div>
            <InlineDecisionArea />
          </div>
        ) : runs.length === 0 ? (
          empty
        ) : tab === 'tools' ? (
          <div className="p-3">
            <div className="text-[11px] mb-2" style={{ color: MONO.t3 }}>
              {t('office.wbTimelineHint')}
            </div>
            <div className="relative">
              {chronological.map(renderTimelineNode)}
            </div>
          </div>
        ) : tab === 'changes' ? (
          (() => {
            const changes: Array<{ step: SubAgentProgressStep; run: SubAgentProgress }> = []
            for (const p of chronological) {
              for (const s of p.steps) {
                if (WRITE_TOOLS.has(s.name) && fileOf(s.arguments)) changes.push({ step: s, run: p })
              }
            }
            if (changes.length === 0) {
              return <div className="p-3 text-xs" style={{ color: MONO.t3 }}>{t('office.wbNoChanges')}</div>
            }
            return (
              <div className="p-3">
                {changes.map(({ step: s, run: p }) => {
                  const label = roleLabel(p.task, p.name)
                  const avatar = roleAvatar(label)
                  return (
                    <div key={s.id} className="flex items-center gap-2 py-1.5" style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
                      <span
                        className="shrink-0 rounded-full flex items-center justify-center"
                        style={{ width: 16, height: 16, background: avatar.bg, color: '#fff', fontSize: 8, fontWeight: 700 }}
                        title={label}
                      >
                        {avatar.char}
                      </span>
                      <span style={{ fontSize: 12, color: s.status === 'error' ? '#DC2626' : s.status === 'running' ? '#0058BC' : '#16A34A' }}>
                        {s.status === 'error' ? '✕' : s.status === 'running' ? '…' : '✓'}
                      </span>
                      <span
                        className="flex-1 truncate text-xs"
                        style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: MONO.t1 }}
                      >
                        {shortFile(fileOf(s.arguments))}
                      </span>
                      <span className="text-xs shrink-0" style={{ color: MONO.t3 }}>
                        {label} · {s.name}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })()
        ) : (
          (() => {
            const cmds: Array<{ step: SubAgentProgressStep; run: SubAgentProgress }> = []
            for (const p of chronological) {
              for (const s of p.steps) {
                if (CMD_TOOLS.has(s.name) && s.arguments.command) cmds.push({ step: s, run: p })
              }
            }
            if (cmds.length === 0) {
              return <div className="p-3 text-xs" style={{ color: MONO.t3 }}>{t('office.wbNoTerm')}</div>
            }
            return (
              <div className="p-3 space-y-2.5">
                {cmds.map(({ step: s, run: p }) => {
                  const label = roleLabel(p.task, p.name)
                  const avatar = roleAvatar(label)
                  return (
                    <div key={s.id} className="rounded-lg overflow-hidden" style={{ background: '#0a0d14' }}>
                      <div className="px-3 py-1.5 flex items-center gap-2">
                        <span
                          className="shrink-0 rounded-full flex items-center justify-center"
                          style={{ width: 14, height: 14, background: avatar.bg, color: '#fff', fontSize: 7, fontWeight: 700 }}
                          title={label}
                        >
                          {avatar.char}
                        </span>
                        <span className="text-xs" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: '#22c55e' }}>
                          $ {truncate(String(s.arguments.command), 140)}
                        </span>
                        <span className="ml-auto text-[10px] shrink-0" style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: '#64748b' }}>
                          {label}
                        </span>
                      </div>
                      {s.result && (
                        <div
                          className="px-3 pb-2 text-xs whitespace-pre-wrap break-all"
                          style={{ fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace", color: '#cbd5e1', lineHeight: 1.6 }}
                        >
                          {truncate(s.result, 3000)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()
        )}
      </div>
    </div>
  )
}
