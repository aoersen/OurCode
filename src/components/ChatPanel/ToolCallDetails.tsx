import { useI18n } from '@/i18n/useI18n'
import type { ChatMessage } from '@/types'

interface ToolCallDetailsProps {
  toolCall: NonNullable<ChatMessage['toolCalls']>[number]
  result?: { result: string; isError?: boolean }
}

/** 工具调用的展开详情：参数 JSON + 完整结果（可复制），错误结果以错误色显示。
 *  轨迹时间线（TraceRow）与对话视图的工具胶囊（ToolStepRow）共用。 */
export default function ToolCallDetails({ toolCall, result }: ToolCallDetailsProps) {
  const t = useI18n()
  const isError = !!result?.isError

  return (
    <div className="border border-nova-border rounded-lg overflow-hidden bg-nova-surface/40">
      <div className="px-2.5 pt-1.5 text-[10px] uppercase tracking-wider text-nova-text-muted font-semibold">
        {t('tool.params')}
      </div>
      <pre className="px-2.5 pb-1.5 pt-0.5 text-[12px] font-mono text-nova-text-secondary whitespace-pre-wrap break-all leading-[1.55] max-h-32 overflow-y-auto">
        {JSON.stringify(toolCall.arguments, null, 2)}
      </pre>
      {result && (
        <>
          <div className="px-2.5 pt-1.5 flex items-center justify-between border-t border-nova-border/60">
            <span className="text-[10px] uppercase tracking-wider text-nova-text-muted font-semibold">
              {t('tool.result')}
            </span>
            <button
              onClick={() => { navigator.clipboard.writeText(result.result).catch(() => { /* ignore */ }) }}
              title={t('common.copy')}
              className="text-[10px] px-1.5 py-0.5 rounded bg-nova-hover border border-nova-border text-nova-text-muted hover:text-nova-text-primary hover:border-nova-accent/40 transition-colors"
            >
              {t('common.copy')}
            </button>
          </div>
          <pre className={`px-2.5 pb-2 pt-0.5 text-[12px] font-mono whitespace-pre-wrap break-all leading-[1.55] max-h-40 overflow-y-auto ${
            isError ? 'text-error' : 'text-nova-text-secondary'
          }`}>
            {result.result}
          </pre>
        </>
      )}
    </div>
  )
}
