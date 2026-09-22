import { useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import SubAgentProgressBlock from './SubAgentProgressBlock'
import ToolCallDetails from './ToolCallDetails'
import MSIcon from '@/components/Common/icons/MSIcon'

export interface ToolStepRowProps {
  toolCall: { id: string; name: string; arguments: Record<string, any> }
  /** Committed result (absent ⇒ the tool is still running) */
  result?: { result: string; isError?: boolean }
  /** Explicit rejection (user declined the batch / tool approval) */
  rejected?: boolean
  /** True when no result will ever arrive (run stopped mid-batch, or a legacy
   *  session whose tool messages were stored standalone). Prevents an eternal
   *  spinner — renders a muted "not executed" state instead. */
  suspended?: boolean
  /** Wall-clock duration of this tool call (ms) — shown as a small badge. */
  durationMs?: number
}

/** Format a millisecond duration as a compact human string (e.g. 1.2s, 340ms). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

const TOOL_LABEL_KEYS: Record<string, TranslationKey> = {
  read_file: 'tool.readFile', read_multiple_files: 'tool.readMultipleFiles', list_directory: 'tool.listDirectory', get_directory_tree: 'tool.getDirectoryTree',
  search_files: 'tool.searchFiles', search_in_files: 'tool.searchInFiles', write_file: 'tool.writeFile',
  edit_file: 'tool.editFile', multi_edit_file: 'tool.multiEditFile', create_directory: 'tool.createDirectory', delete_file: 'tool.deleteFile',
  run_command: 'tool.runCommand', manage_todo: 'tool.manageTodo', submit_plan: 'tool.submitPlan',
  ask_user_question: 'tool.askUserQuestion', web_search: 'tool.webSearch', read_url: 'tool.readUrl',
}

/** Extract a compact display key from a tool call's arguments */
export function extractKey(tc: ToolStepRowProps['toolCall']): string {
  switch (tc.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_directory':
    case 'get_directory_tree':
    case 'create_directory':
    case 'delete_file':
      return tc.arguments.path?.split(/[/\\]/).pop() || tc.arguments.path || ''
    case 'read_multiple_files': {
      const paths = tc.arguments.paths?.length || 0
      return `${paths} files`
    }
    case 'multi_edit_file': {
      const edits = tc.arguments.edits?.length || 0
      return `${edits} edits`
    }
    case 'search_files': return tc.arguments.pattern || ''
    case 'search_in_files': return tc.arguments.query || ''
    case 'run_command': return tc.arguments.command?.slice(0, 50) || ''
    case 'manage_todo': return `${tc.arguments.todos?.length || 0} items`
    case 'submit_plan': return tc.arguments.title || ''
    case 'ask_user_question': return tc.arguments.question?.slice(0, 40) || ''
    case 'web_search': return tc.arguments.query || ''
    case 'read_url': return tc.arguments.url || ''
    case 'run_subagent': return tc.arguments.name || tc.arguments.description?.slice(0, 30) || 'sub-agent'
    case 'send_message': return tc.arguments.targetSessionId || tc.arguments.targetTitle || ''
    default:
      if (tc.name.startsWith('mcp__')) return tc.name.slice('mcp__'.length).split('__').pop() || tc.name
      return JSON.stringify(tc.arguments).slice(0, 40)
  }
}

/** Collapse a long result to a one-line summary (shown on the pill's tooltip) */
function summarizeResult(result: string, maxLen = 90): string {
  const flat = result.replace(/\s+/g, ' ').trim()
  return flat.length > maxLen ? flat.slice(0, maxLen) + '…' : flat
}

/**
 * 单个工具调用行（Stitch「全工具增强版」设计）：圆角胶囊
 *  = Material 图标 + mono 工具名 + 琥珀色 key chip + 分隔线 + 状态，
 *  点击展开参数/完整结果。Pending 胶囊带蓝色描边与旋转 spinner。
 */
export default function ToolStepRow({ toolCall, result, rejected, suspended = false, durationMs }: ToolStepRowProps) {
  const [expanded, setExpanded] = useState(false)
  const t = useI18n()

  const labelKey = TOOL_LABEL_KEYS[toolCall.name]
  const key = extractKey(toolCall)
  const isPending = !result && !rejected && !suspended
  const isError = !!result?.isError || !!rejected

  // mockup「极简纯净版」工具 chip（对齐 code.html #5 Tool Calls）：
  // [状态图标] 工具名(mono 13px) 路径(12px 截断 100px)，白底 + #e2e8f0 细边框；
  // 仅 pending 用 accent 蓝（sync 旋转 + 浅蓝底），完成/失败保持中性灰。
  const pillCls = expanded
    ? 'border-nova-accent/40 bg-nova-hover'
    : isPending
      ? 'border-[#e2e8f0] bg-primary-container/50 hover:border-nova-accent/30'
      : 'border-[#e2e8f0] bg-white dark:bg-nova-surface dark:border-white/10 hover:border-[#cbd5e1] dark:hover:border-white/20'

  return (
    <div className="flex flex-col gap-1">
      {/* The chip row */}
      <button
        onClick={() => setExpanded(!expanded)}
        title={
          isPending ? t('tool.running')
          : suspended ? t('tool.notExecuted')
          : rejected ? t('tool.rejected')
          : result?.result ? summarizeResult(result.result) : undefined
        }
        className={`inline-flex items-center gap-2 px-3 py-1 rounded-md border transition-colors select-none text-left max-w-full ${pillCls}`}
      >
        {/* 状态图标在前（mockup：check / sync 旋转 / close），中性灰，
            仅 pending 用 accent */}
        {suspended ? (
          <span className="text-nova-text-muted text-[12px] leading-none shrink-0">–</span>
        ) : isPending ? (
          <MSIcon name="sync" className="text-[14px] leading-none text-nova-accent animate-spin-slow shrink-0" />
        ) : isError ? (
          <MSIcon name="close" className="text-[14px] leading-none text-nova-text-muted shrink-0" />
        ) : (
          <MSIcon name="check" className="text-[14px] leading-none text-nova-text-muted shrink-0" />
        )}
        <span className={`font-mono text-[13px] shrink-0 ${isPending ? 'text-nova-text-primary' : 'text-nova-text-muted'}`}>
          {labelKey ? t(labelKey) : toolCall.name}
        </span>
        {key && (
          <span className="text-[12px] text-nova-text-muted truncate max-w-[100px]">
            {key}
          </span>
        )}
        {durationMs != null && (
          <span className="text-[11px] font-mono text-nova-text-muted/80 shrink-0" title={`${durationMs}ms`}>
            {formatMs(durationMs)}
          </span>
        )}
        {/* Chevron — 展开/收起 */}
        <MSIcon name="expand_more" className={`text-[14px] leading-none text-nova-text-muted shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* Expandable detail: args + full result */}
      {expanded && (
        <div className="ml-2">
          <ToolCallDetails toolCall={toolCall} result={result} />
        </div>
      )}

      {/* 子智能体（run_subagent）：胶囊下方内嵌实时执行进度面板 —— 思考、
          内部工具调用与结果边执行边显示，不再等到最终报告才可见 */}
      {toolCall.name === 'run_subagent' && (
        <SubAgentProgressBlock toolCallId={toolCall.id} />
      )}
    </div>
  )
}
