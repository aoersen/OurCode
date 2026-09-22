import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { formatMs, extractKey } from './ToolStepRow'
import SubAgentProgressBlock from './SubAgentProgressBlock'
import { buildTraceEntries } from './traceEntries'
import type { TraceEntry } from './traceEntries'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * 轨迹视图（V4 高密度终端风）—— 全 JetBrains Mono 紧凑日志：
 * 头部「执行轨迹 + N 条记录统计」，主体为逐条编号行（序号 + U/A/T 色标 +
 * 状态图标 + 单行摘要），行间发丝线分隔；点击行内联展开参数/完整结果。
 * 数据源是 session.messages，运行中随 appendToolResult / addMessage 自动更新。
 */

const MARKER_LABEL: Record<TraceEntry['kind'], string> = { user: 'U', ai: 'A', tool: 'T' }

const MARKER_CLS: Record<TraceEntry['kind'], string> = {
  user: 'bg-accent-10 text-nova-accent',
  ai: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  tool: 'bg-warning-10 text-warning',
}

export default function AgentTraceView() {
  const t = useI18n()
  const session = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const isSessionRunning = useChatStore((s) => s.runningSessionIds.includes(s.activeSessionId ?? ''))
  const messages = session?.messages ?? []
  const entries = buildTraceEntries(messages, isSessionRunning)

  if (entries.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-nova-text-muted text-sm">
        {t('agent.traceEmpty')}
      </div>
    )
  }

  const errors = entries.filter((e) => e.kind === 'tool' && !!e.result?.isError && !e.rejected).length

  return (
    <div className="h-full flex flex-col">
      {/* 头部：标题 + 统计 */}
      <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-nova-border flex flex-col gap-0.5">
        <h2 className="text-[14px] font-semibold leading-tight text-nova-text-primary">{t('agent.trace')}</h2>
        <span className="font-mono text-[10px] leading-tight text-nova-text-muted">
          {t('agent.traceStats', { records: entries.length, errors })}
        </span>
      </div>

      {/* 高密度日志 */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-[20px] py-0.5">
        {entries.map((entry, i) => (
          <TraceRow key={entry.id} index={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function TraceRow({ index, entry }: { index: number; entry: TraceEntry }) {
  const t = useI18n()
  const [expanded, setExpanded] = useState(false)
  const isTool = entry.kind === 'tool'
  const rejected = isTool && entry.rejected
  const isError = isTool && (!!entry.result?.isError || rejected)
  const isPending = isTool && !entry.result && !rejected && !entry.suspended
  const hasDetails = isTool || !!entry.content || ('thinking' in entry && !!entry.thinking)

  return (
    <div
      className={`group border-b border-nova-border transition-colors ${
        isError ? 'bg-error-5 hover:bg-error-10' : 'hover:bg-nova-hover'
      }`}
    >
      <div className="flex items-start px-2 py-1">
        {/* 序号 */}
        <span
          className={`w-5 text-right text-[10px] tabular-nums shrink-0 pt-[2px] mr-2.5 ${
            isError ? 'text-error opacity-70' : 'text-nova-text-muted'
          }`}
        >
          {index + 1}
        </span>
        {/* U/A/T 角色色标 */}
        <span className={`w-4 h-4 rounded text-[11px] font-semibold flex items-center justify-center shrink-0 mr-2 mt-[1px] ${MARKER_CLS[entry.kind]}`}>
          {MARKER_LABEL[entry.kind]}
        </span>
        {/* 状态图标 */}
        <span className="w-4 flex justify-center shrink-0 mr-2 mt-[1px]">
          <StatusIcon entry={entry} isError={isError} isPending={isPending} />
        </span>
        {/* 内容 + 内联展开块 */}
        <div className="min-w-0 flex-1">
          <div
            role={hasDetails ? 'button' : undefined}
            tabIndex={hasDetails ? 0 : undefined}
            onClick={hasDetails ? () => setExpanded(!expanded) : undefined}
            onKeyDown={hasDetails ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded) } } : undefined}
            className={`flex items-center gap-1 min-w-0 ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <RowContent entry={entry} isError={isError} />
            {hasDetails && (
              <MSIcon name="expand_more" className={`text-[14px] leading-none shrink-0 transition-transform duration-200 ${
                  expanded ? 'rotate-180 text-nova-accent' : 'text-nova-text-muted opacity-0 group-hover:opacity-100'
                }`} />
            )}
          </div>

          {expanded && hasDetails && (
            <div className="ml-2 pl-2.5 py-1 border-l-2 border-nova-border">
              {isTool ? (
                <div className="flex flex-col gap-1">
                  <V4Details toolCall={entry.toolCall} result={entry.result} />
                  {entry.toolCall.name === 'run_subagent' && <SubAgentProgressBlock toolCallId={entry.toolCall.id} />}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {entry.kind === 'ai' && entry.thinking && (
                    <div className="text-[11px] leading-[1.6] text-nova-text-muted whitespace-pre-wrap break-words">
                      {t('chat.thinkingTitle')}：{entry.thinking}
                    </div>
                  )}
                  <div className="text-[11px] leading-[1.6] text-nova-text-secondary whitespace-pre-wrap break-words">
                    {entry.content}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 状态图标：工具 = ✓ / ✗ / 旋转 sync / –；用户与 AI = – */
function StatusIcon({ entry, isError, isPending }: { entry: TraceEntry; isError: boolean; isPending: boolean }) {
  if (entry.kind !== 'tool' || entry.suspended) {
    return <span className="text-nova-text-muted">–</span>
  }
  if (isPending) {
    return <MSIcon name="sync" className="text-[14px] leading-none text-nova-accent animate-spin-slow" />
  }
  if (isError) {
    return <MSIcon name="close" className="text-[14px] leading-none text-error" />
  }
  return <MSIcon name="check" className="text-[14px] leading-none text-success" />
}

/** 单行内容：工具 = 工具名 · 摘要（路径/查询/命令）· 耗时；用户/AI = 正文首行 */
function RowContent({ entry, isError }: { entry: TraceEntry; isError: boolean }) {
  if (entry.kind === 'tool') {
    const summary = isError
      ? summarize(entry.result?.result ?? '')
      : toolSummary(entry.toolCall) || (entry.result ? summarize(entry.result.result) : '')
    return (
      <span className="min-w-0 flex-1 truncate pr-1">
        <span className={isError ? 'text-error' : 'text-nova-text-secondary'}>{entry.toolCall.name}</span>
        {summary && (
          <span className={isError ? 'text-error' : 'text-nova-text-muted'}> · {summary}</span>
        )}
        {entry.result?.durationMs != null && (
          <span className={`text-[10px] ml-1 ${isError ? 'text-error opacity-70' : 'text-nova-text-muted'}`}>
            ({formatMs(entry.result.durationMs)})
          </span>
        )}
      </span>
    )
  }
  if (entry.content.trim()) {
    return <span className="min-w-0 flex-1 pr-1 break-words text-nova-text-primary">{firstLine(entry.content)}</span>
  }
  return <span className="min-w-0 flex-1 pr-1 text-nova-text-muted">…</span>
}

/** 展开详情（V4 高密度块）：参数 JSON + 完整结果（悬停显示复制） */
function V4Details({
  toolCall,
  result,
}: {
  toolCall: { id: string; name: string; arguments: Record<string, any> }
  result?: { result: string; isError?: boolean }
}) {
  const t = useI18n()
  return (
    <div className="relative bg-nova-bg rounded-md border border-nova-border p-2.5 overflow-hidden">
      <div className="mb-2">
        <div className="text-[11px] font-bold text-nova-text-muted uppercase tracking-wider mb-0.5">{t('tool.params')}</div>
        <pre className="text-nova-text-secondary text-[11px] leading-[1.5] whitespace-pre-wrap break-all">
          {JSON.stringify(toolCall.arguments, null, 2)}
        </pre>
      </div>
      {result && (
        <>
          <div className="h-px bg-nova-border my-1.5" />
          <div className="mb-1">
            <div className="text-[11px] font-bold text-nova-text-muted uppercase tracking-wider mb-0.5">{t('tool.result')}</div>
            <pre className={`text-[11px] leading-[1.5] whitespace-pre-wrap break-all line-clamp-6 ${result.isError ? 'text-error' : 'text-nova-text-muted'}`}>
              {result.result}
            </pre>
          </div>
          <button
            onClick={() => { navigator.clipboard.writeText(result.result).catch(() => { /* ignore */ }) }}
            title={t('common.copy')}
            className="absolute top-1.5 right-1.5 flex items-center gap-1 text-nova-text-muted hover:text-nova-text-primary bg-nova-surface hover:bg-nova-surface border border-nova-border rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MSIcon name="content_copy" className="text-[12px] leading-none" />
            <span className="text-[11px]">{t('common.copy')}</span>
          </button>
        </>
      )}
    </div>
  )
}

/** 工具摘要：优先取参数里的路径（完整路径，对齐 V4 设计），否则退回 extractKey */
function toolSummary(toolCall: { id: string; name: string; arguments: Record<string, any> }): string {
  const p = toolCall.arguments.path
  if (typeof p === 'string' && p) return p
  return extractKey(toolCall)
}

/** 取首个非空行作为单行预览（保留纯空白内容原样） */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  return line ?? text
}

/** 折叠长结果到一行摘要 */
function summarize(result: string, maxLen = 60): string {
  const flat = result.replace(/\s+/g, ' ').trim()
  return flat.length > maxLen ? flat.slice(0, maxLen) + '…' : flat
}
