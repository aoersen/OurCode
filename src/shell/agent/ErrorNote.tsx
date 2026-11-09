import { useState } from 'react'
import { classifyError } from './errors'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'

/**
 * 消息级错误卡：一句人话 + 一个能做的事。
 * 不是红色横幅、不是 toast —— 就停在出错那条消息下面，滚动到哪儿都跟着。
 */
export default function ErrorNote({
  sessionId,
  messageId,
  message,
}: {
  sessionId: string
  messageId: string
  message?: string
}) {
  const view = classifyError(message)
  const retry = useChatStore((s) => s.retryFailedRequest)
  const createSession = useChatStore((s) => s.createSession)
  const configGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const openSettings = useUIStore((s) => s.openSettings)
  const [showDetail, setShowDetail] = useState(false)

  const runAction = () => {
    if (view.action === 'retry') void retry(sessionId, messageId)
    else if (view.action === 'settings') openSettings()
    else if (view.action === 'newSession' && configGroupId) createSession(configGroupId)
  }

  const hasDetail = Boolean(message && message.trim() && message.trim() !== view.hint)

  return (
    <div
      data-testid="shell-error-note"
      className="mt-3 rounded-xl bg-[var(--pure-code)] px-3.5 py-2.5"
      role="status"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--pure-danger)]"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] leading-[20px] text-[var(--pure-ink)]">{view.hint}</div>
          <div className="mt-1 flex items-center gap-3 text-[12px] leading-[18px]">
            {view.actionLabel && (
              <button
                type="button"
                onClick={runAction}
                className="pure-focus text-[var(--pure-ink)] hover:underline underline-offset-2"
              >
                {view.actionLabel}
              </button>
            )}
            {hasDetail && (
              <button
                type="button"
                onClick={() => setShowDetail((open) => !open)}
                aria-expanded={showDetail}
                className="pure-focus text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors"
              >
                {showDetail ? '收起详情' : '详情'}
              </button>
            )}
          </div>
          {hasDetail && showDetail && (
            <div className="mt-2 pure-mono-well">{message}</div>
          )}
        </div>
      </div>
    </div>
  )
}
