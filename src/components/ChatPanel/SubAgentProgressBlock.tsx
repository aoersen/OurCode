import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import ToolStepRow from './ToolStepRow'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 子智能体实时进度面板 —— 渲染在父级 run_subagent 工具胶囊下方。
 *
 * 子智能体在它自己的工具调用内部自主运行（不产生嵌套消息），如果没有这个
 * 面板，它整个执行过程（思考 → 内部工具调用 → 每步结果）在最终报告返回前
 * 完全不可见。进度数据由 subagentRunner 通过 chatStore.updateSubagentProgress
 * 实时推送，以父级工具调用的 id 为键；这里按同一个键订阅。
 */
export default function SubAgentProgressBlock({ toolCallId }: { toolCallId: string }) {
  const progress = useChatStore((s) => s.subagentProgress[toolCallId])
  const t = useI18n()
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const isRunning = progress?.status === 'running'
  // 运行中自动展开思考区，让用户能看到子智能体正在推理什么；结束后保持当前
  // 状态（用户可自由折叠/展开）。
  useEffect(() => {
    if (isRunning) setThinkingOpen(true)
  }, [isRunning])

  if (!progress) return null

  const statusIcon =
    isRunning ? (
      <MSIcon name="progress_activity" className="text-[13px] leading-none text-nova-accent animate-spin-slow shrink-0" />
    ) : progress.status === 'done' ? (
      <MSIcon name="check" className="text-[13px] leading-none text-success shrink-0" />
    ) : progress.status === 'error' ? (
      <MSIcon name="close" className="text-[13px] leading-none text-error shrink-0" />
    ) : (
      <MSIcon name="stop" className="text-[13px] leading-none text-nova-text-muted shrink-0" />
    )

  const contextLine = progress.description || progress.task
  const working = isRunning && progress.thinking === '' && progress.steps.length === 0

  return (
    <div className="ml-2.5 pl-2.5 border-l-2 border-nova-border/70 flex flex-col gap-1.5 py-0.5">
      {/* 头部：角色名 + 状态 + 统计 */}
      <div className="flex items-center gap-1.5 min-w-0">
        <MSIcon name="smart_toy" className="text-[14px] leading-none text-nova-accent shrink-0" />
        <span className="font-mono text-[12px] text-nova-text-primary font-medium shrink-0">{progress.name}</span>
        <span className="text-[11px] text-nova-text-muted shrink-0">{t('chat.subagentTitle')}</span>
        {statusIcon}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-nova-text-muted">
          {t('chat.subagentToolCalls', { n: progress.toolCallCount })}
          {progress.tokenCount > 0 && <> · {t('chat.subagentTokens', { n: progress.tokenCount })}</>}
        </span>
      </div>

      {/* 任务/背景描述 */}
      {contextLine && (
        <div className="text-[11px] text-nova-text-muted leading-snug line-clamp-2 break-words">
          {contextLine}
        </div>
      )}

      {/* 刚开始，尚无任何输出 */}
      {working && (
        <div className="text-[11px] text-nova-text-muted animate-pulse">{t('chat.subagentWorking')}</div>
      )}

      {/* 实时思考（运行中自动展开） */}
      {progress.thinking && (
        <div className="flex flex-col gap-0.5">
          <button
            onClick={() => setThinkingOpen(!thinkingOpen)}
            className="inline-flex items-center gap-1 text-left select-none cursor-pointer group w-fit"
          >
            <span className="text-[11px] font-medium text-nova-text-muted group-hover:text-nova-text-secondary">
              {t('chat.subagentThinking')}
            </span>
            <MSIcon name="expand_more" className={`text-[12px] leading-none text-nova-text-muted transition-transform duration-200 ${thinkingOpen ? 'rotate-180' : ''}`} />
          </button>
          {thinkingOpen && (
            <div className="text-[12px] leading-[1.6] text-nova-text-muted whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {progress.thinking}
            </div>
          )}
        </div>
      )}

      {/* 子智能体自己的工具调用（内部步骤），按发生顺序 */}
      {progress.steps.length > 0 && (
        <div className="flex flex-col gap-1">
          {progress.steps.map((st) => (
            <ToolStepRow
              key={st.id}
              toolCall={{ id: st.id, name: st.name, arguments: st.arguments }}
              result={st.result ? { result: st.result, isError: st.status === 'error' } : undefined}
              // 停止/结束瞬间仍卡在 running 的步骤永远不会再有结果 —— 渲染为
              // 静默的「未执行」状态，避免永远转圈
              suspended={!isRunning && st.status === 'running'}
            />
          ))}
        </div>
      )}
    </div>
  )
}
