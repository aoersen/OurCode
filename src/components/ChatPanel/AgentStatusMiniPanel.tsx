import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useShallow } from 'zustand/react/shallow'
import { useI18n } from '@/i18n/useI18n'
import type { SubAgentProgress, TodoItem } from '@/types'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * Agent 状态迷你面板 —— 对话面板左上角悬浮的极简纯净白小面板（V5 落地）。
 *
 * 收起态 = 一条白底胶囊（Agent · 绿点 · 3/4 · 箭头）；展开态 = 发丝线卡，
 * 三个区块：计划（plan 文档，可展开/收起）/ 任务（todo 清单）/ 子智能体
 * （每行右侧 > 展开该子 agent 的实时进度）。替代原 TodoPanel。
 *
 * 数据全部来自 chatStore（todos / planContent / subagentProgress），无新
 * 持久化字段。默认收起，Agent 运行中自动展开（只扩不缩，结束后保持手动
 * 状态 —— 与 SubAgentProgressBlock 的交互一致）。
 */

/** 状态图标 —— 仅运行中用 accent 强调，完成/待办保持中性（对齐 TodoPanel）。 */
function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <MSIcon name="check_circle" className="text-[16px] leading-none text-success shrink-0" />
    )
  }
  if (status === 'failed') {
    return (
      <MSIcon name="close" className="text-[16px] leading-none text-error shrink-0" />
    )
  }
  if (status === 'in_progress') {
    return (
      <MSIcon name="progress_activity" className="text-[16px] leading-none animate-spin-slow text-nova-accent shrink-0" />
    )
  }
  return (
    <MSIcon name="radio_button_unchecked" className="text-[16px] leading-none text-nova-text-muted opacity-60 shrink-0" />
  )
}

/** 子智能体状态图标 —— 运行中旋转，成功对勾，失败红叉，其余中性。 */
function SubagentStatusIcon({ status }: { status: SubAgentProgress['status'] }) {
  if (status === 'running') {
    return (
      <MSIcon name="progress_activity" className="text-[14px] leading-none animate-spin-slow text-nova-accent shrink-0" />
    )
  }
  if (status === 'done') {
    return (
      <MSIcon name="check_circle" className="text-[14px] leading-none text-success shrink-0" />
    )
  }
  if (status === 'error') {
    return (
      <MSIcon name="close" className="text-[14px] leading-none text-error shrink-0" />
    )
  }
  return (
    <MSIcon name="stop_circle" className="text-[14px] leading-none text-nova-text-muted shrink-0" />
  )
}

/** 子智能体状态文字。 */
function subagentStatusLabel(status: SubAgentProgress['status'], t: (k: any) => string): string {
  switch (status) {
    case 'running': return t('agent.statusRunning')
    case 'done': return t('agent.statusDone')
    case 'error': return t('agent.statusError')
    default: return t('agent.statusStopped')
  }
}

export default function AgentStatusMiniPanel({ sessionId }: { sessionId: string }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId))
  // 只订阅本会话的 subagent 进度。要点：selector 必须返回**稳定引用** ——
  // Object.values 的元素是 store 里的进度对象本身（引用稳定），useShallow
  // 按元素 Object.is 比较后引用保持不变，只在真的变化时才重渲染。绝不能对
  // Object.entries().filter()（每次生成全新元组数组）用 useShallow：快照每次
  // 渲染都"变了"，useSyncExternalStore 会无限强制重渲染，把整个页面卡死。
  const sessionSubagents = useChatStore(useShallow((s) =>
    Object.values(s.subagentProgress).filter((p) => p.sessionId === sessionId)
  ))
  // subagentProgress 以父 run_subagent 的 toolCallId 为 key —— 进度对象本身
  // 不含 id，这里按引用反查 key，组装成 [id, progress] 条目（仅在本会话条目
  // 变化时重建）。
  const subagentEntries = useMemo(() => {
    const idByRef = new Map<SubAgentProgress, string>()
    for (const [id, p] of Object.entries(useChatStore.getState().subagentProgress)) idByRef.set(p, id)
    return sessionSubagents.map((p) => [idByRef.get(p) ?? '', p] as [string, SubAgentProgress])
  }, [sessionSubagents])
  const isRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const t = useI18n()

  const [collapsed, setCollapsed] = useState(true)
  // 计划文档默认展开（V5：展开态直接展示 plan 文档，点图标收起）
  const [planOpen, setPlanOpen] = useState(true)
  // 当前展开进度详情的子智能体 toolCallId
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

  const todos = session?.todos || []
  const planContent = session?.planContent

  // 运行中自动展开（只扩不缩）；结束后保持用户手动状态。
  useEffect(() => {
    if (isRunning) setCollapsed(false)
  }, [isRunning])

  // 解析 plan 文档（与 PlanCard 相同的 JSON 结构 {title, steps:[{summary,detail}]}）
  const plan = useMemo(() => {
    if (!planContent) return null
    try {
      const p = JSON.parse(planContent)
      return {
        title: (p && p.title) || t('agent.executePlan'),
        steps: Array.isArray(p?.steps) ? p.steps : [],
      }
    } catch {
      return { title: t('agent.executePlan'), steps: [] }
    }
  }, [planContent, t])

  const done = todos.filter((x) => x.status === 'completed').length
  const total = todos.length
  // 执行状态：会话运行中，或有 in_progress 的 todo —— 胶囊需显示「执行中」
  const executing = isRunning || todos.some((x) => x.status === 'in_progress')
  // 当前正在执行的那一项 todo（胶囊直接显示它的内容）
  const activeTodo = todos.find((x) => x.status === 'in_progress')

  // 三者全空 → 不渲染（对齐原 TodoPanel 行为）
  if (!session || (total === 0 && !planContent && subagentEntries.length === 0)) return null

  const subagents = subagentEntries.map(([id, p]) => ({ id, ...p }))

  /* ── 收起胶囊态（默认）──
     white capsule + hairline + smart_toy + 当前执行 todo（或 Agent 执行中）+ 旋转进度图标 + 3/4 + 箭头。
     胶囊内容实时跟随 session.todos —— 当前 in_progress 任务推进时文字随之切换。 */
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="self-start mx-6 mt-3 mb-1 shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-full bg-nova-surface border border-nova-border shadow-sm hover:bg-nova-hover transition-colors cursor-pointer select-none"
        title={t('agent.panelExpand')}
      >
        <MSIcon name="smart_toy" className="text-[14px] leading-none text-nova-accent shrink-0" />
        {executing && activeTodo ? (
          <span className="text-[12px] font-medium text-nova-text-primary max-w-[180px] truncate leading-snug">
            {activeTodo.content}
          </span>
        ) : (
          <span className="text-[12px] font-medium text-nova-text-primary shrink-0">
            {executing ? t('agent.miniPanelRunning') : t('agent.miniPanelTitle')}
          </span>
        )}
        {executing && (
          <MSIcon name="progress_activity" className="text-[12px] leading-none text-nova-accent animate-spin-slow shrink-0" />
        )}
        {total > 0 && (
          <>
            <span className="w-px h-3 bg-nova-border mx-0.5 shrink-0" aria-hidden />
            <span className="font-mono text-[11px] text-success shrink-0">{done}/{total}</span>
          </>
        )}
        <MSIcon name="expand_more" className="text-[12px] leading-none text-nova-text-muted shrink-0" />
      </button>
    )
  }

  /* ── 展开态：发丝线卡 + 三区块 ── */
  return (
    <div className="absolute left-6 top-4 z-10 w-[340px] bg-nova-surface border border-nova-border rounded-xl shadow-sm overflow-hidden">
      {/* 面板头一行：Agent 标题 + 绿点 + 3/4 + 收起成胶囊 */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <MSIcon name="smart_toy" className="text-[15px] leading-none text-nova-accent shrink-0" />
        <span className="text-[12px] font-semibold text-nova-text-primary shrink-0">
          {executing ? t('agent.miniPanelRunning') : t('agent.miniPanelTitle')}
        </span>
        {executing && <span className="w-[6px] h-[6px] rounded-full bg-success animate-pulse" aria-hidden />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {total > 0 && <span className="font-mono text-[11px] text-success">{done}/{total}</span>}
          <button
            onClick={() => setCollapsed(true)}
            className="w-6 h-6 flex items-center justify-center rounded-md text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors cursor-pointer"
            title={t('agent.panelCollapse')}
          >
            <MSIcon name="expand_less" className="text-[14px] leading-none" />
          </button>
        </span>
      </div>

      {/* ① 计划区 */}
      {plan && (
        <div className="border-t border-nova-border/60 px-3 pt-2 pb-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-nova-text-muted shrink-0">
              {t('agent.miniPanelPlan')}
            </span>
            <button
              onClick={() => setPlanOpen(!planOpen)}
              className="w-5 h-5 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors cursor-pointer ml-auto"
              title={planOpen ? t('agent.planCollapse') : t('agent.planExpand')}
            >
              <MSIcon name="expand_less" className={`text-[14px] leading-none transition-transform duration-200 ${planOpen ? '' : 'rotate-180'}`} />
            </button>
          </div>
          {planOpen && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start gap-1.5">
                <MSIcon name="assignment" className="text-[14px] leading-none text-nova-accent mt-[1px] shrink-0" />
                <span className="text-[12px] font-semibold text-nova-text-primary leading-snug">{plan.title}</span>
              </div>
              {plan.steps.length > 0 ? (
                <ol className="flex flex-col gap-1">
                  {plan.steps.map((step: any, i: number) => (
                    <li key={i} className="flex items-start gap-1.5 text-[12px]">
                      <span className="shrink-0 w-4 h-4 rounded-full bg-nova-accent/15 text-nova-accent text-[11px] flex items-center justify-center font-medium mt-[1px]">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-nova-text-primary leading-snug">{step?.summary || ''}</div>
                        {step?.detail && <div className="text-[11px] text-nova-text-muted leading-snug">{step.detail}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <pre className="text-[11px] text-nova-text-secondary whitespace-pre-wrap break-words">{planContent}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* ② 任务区 */}
      {total > 0 && (
        <div className="border-t border-nova-border/60 px-3 pt-2 pb-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-nova-text-muted shrink-0">
              {t('agent.miniPanelTasks')}
            </span>
            <span className="ml-auto font-mono text-[11px] text-success">{done}/{total}</span>
          </div>
          <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
            {todos.map((todo) => (
              <div
                key={todo.id}
                className={`flex items-center gap-2 px-1 py-[3px] rounded-md hover:bg-nova-hover transition-colors ${
                  todo.status === 'completed'
                    ? 'text-nova-text-muted line-through opacity-70'
                    : todo.status === 'pending'
                      ? 'text-nova-text-muted'
                      : todo.status === 'in_progress'
                        ? 'text-nova-text-primary font-medium'
                        : 'text-nova-text-primary'
                }`}
              >
                <TodoStatusIcon status={todo.status} />
                <span className="min-w-0 flex-1 leading-snug text-[12px]">{todo.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ③ 子智能体区 */}
      {subagents.length > 0 && (
        <div className="border-t border-nova-border/60 px-3 pt-2 pb-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-nova-text-muted shrink-0">
              {t('agent.miniPanelAgents')}
            </span>
            <span className="ml-auto w-[16px] h-[16px] rounded-full bg-success-10 text-success flex items-center justify-center font-mono text-[10px] font-bold">
              {subagents.length}
            </span>
          </div>
          <div className="flex flex-col">
            {subagents.map((sa) => {
              const open = expandedAgent === sa.id
              return (
                <div key={sa.id} className="flex flex-col">
                  <button
                    onClick={() => setExpandedAgent(open ? null : sa.id)}
                    className="flex items-center gap-2 py-[5px] px-1 -mx-1 rounded-md hover:bg-nova-hover transition-colors cursor-pointer select-none text-left"
                  >
                    <SubagentStatusIcon status={sa.status} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-nova-text-primary">{sa.name}</span>
                    <span
                      className={`shrink-0 text-[10px] ${
                        sa.status === 'running'
                          ? 'text-nova-accent'
                          : sa.status === 'done'
                            ? 'text-success'
                            : sa.status === 'error'
                              ? 'text-error'
                              : 'text-nova-text-muted'
                      }`}
                    >
                      {subagentStatusLabel(sa.status, t)}
                    </span>
                    <MSIcon name="chevron_right" className={`text-[14px] leading-none text-nova-text-muted shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
                  </button>
                  {/* 行级展开：思考摘要 + 工具步骤 + 统计 */}
                  {open && (
                    <div className="ml-[26px] mb-1.5 bg-nova-hover/60 border border-nova-border/60 rounded-md px-2 py-1.5 flex flex-col gap-1">
                      {sa.thinking && (
                        <div className="text-[11px] text-nova-text-secondary leading-snug line-clamp-3 break-words">
                          {sa.thinking}
                        </div>
                      )}
                      {sa.steps.length > 0 && (
                        <div className="flex flex-col gap-0.5 font-mono text-[11px] text-nova-text-muted">
                          {sa.steps.map((st) => (
                            <div key={st.id} className="flex items-center gap-1.5 min-w-0">
                              {st.status === 'running' ? (
                                <MSIcon name="progress_activity" className="text-[12px] leading-none text-nova-accent animate-spin-slow shrink-0" />
                              ) : st.status === 'error' ? (
                                <MSIcon name="close" className="text-[12px] leading-none text-error shrink-0" />
                              ) : (
                                <MSIcon name="check" className="text-[12px] leading-none text-success shrink-0" />
                              )}
                              <span className="min-w-0 truncate">{st.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="pt-0.5 border-t border-nova-border/50 text-[10px] text-nova-text-muted font-mono">
                        {t('chat.subagentToolCalls', { n: sa.toolCallCount })}
                        {sa.tokenCount > 0 && <> · {t('chat.subagentTokens', { n: sa.tokenCount })}</>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
