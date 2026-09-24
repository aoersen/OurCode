/**
 * 底部对话条（一人公司）：纯输入通道，只与总监对话。
 *
 * 设计初衷：用户不直接对话工作人员——所有消息发给总监，由总监按目标模式
 * SPEC 把任务分发给各角色（需求分析/研发/UI/测试），角色回报回到本面板。
 * 早前的「@角色 定向派活」chips 已按此初衷移除。
 *
 * 对话流（OfficeStream）与内嵌决策区（InlineDecisionArea）在中央工作台
 * 「对话」页签——本条只保留输入。保留 data-testid="office-chat-pane"（e2e 依赖）。
 */
import { useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { MONO } from './officeTheme'
import { IS_OFFICE } from '@/utils/windowMode'
import { isComposingEvent } from '@/utils/composition'

export default function OfficeChatBar() {
  const t = useI18n()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const running = useChatStore(
    (s) => !!s.activeSessionId && s.runningSessionIds.includes(s.activeSessionId),
  )
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const openChat = () => {
    if (IS_OFFICE) {
      const configId = useConfigStore.getState().activeConfigGroupId
      if (configId) {
        useChatStore.getState().createSession(configId, useUIStore.getState().rootPath || undefined)
        return
      }
      useUIStore.getState().openSettings()
      return
    }
    useUIStore.getState().setActiveSidebarTab('files')
  }

  // 空会话：引导创建（与原对话面板一致）
  if (!activeSessionId) {
    return (
      <div
        data-testid="office-chat-pane"
        className="h-full flex items-center justify-center"
        style={{ background: '#fff', borderTop: `1px solid ${MONO.hairline}` }}
      >
        <div className="text-center max-w-[280px]">
          <div style={{ fontSize: 13, color: MONO.t2, marginBottom: 12 }}>{t('office.noActiveSession')}</div>
          <button
            onClick={openChat}
            className="transition-colors hover:bg-[#F4F4F5]"
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 500,
              color: MONO.t1, background: MONO.bg,
              border: `1px solid ${MONO.hairline}`, borderRadius: 4, cursor: 'pointer',
            }}
          >
            {t('office.openChat')}
          </button>
        </div>
      </div>
    )
  }

  // 所有消息原样发给总监：不解析、不前缀、不定向——任务分派是总监的职责。
  const send = () => {
    const value = text.trim()
    if (!value) return
    setText('')
    void useChatStore.getState().sendMessage(activeSessionId, value)
    inputRef.current?.focus()
  }

  return (
    <div
      data-testid="office-chat-pane"
      className="shrink-0 flex flex-col justify-center gap-2 px-4"
      style={{
        minHeight: 88,
        background: '#fff',
        borderTop: '1px solid rgba(15,23,42,0.08)',
      }}
    >
      {/* 常驻提示：对话仅面向总监 */}
      <div className="flex items-center gap-1.5">
        <span
          className="shrink-0 rounded-full px-2 py-0.5"
          style={{
            fontSize: 10, color: MONO.t3, background: 'rgba(15,23,42,0.04)',
            border: `1px dashed ${MONO.hairline}`, lineHeight: 1.6,
          }}
        >
          {t('office.directorOnlyHint')}
        </span>
        {running && (
          <span className="flex items-center gap-1.5 ml-auto" style={{ fontSize: 12, color: MONO.t2 }}>
            <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: '#22C55E' }} />
            {t('office.running')}
          </span>
        )}
      </div>

      {/* 输入行 */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingEvent(e)) send()
          }}
          placeholder={t('office.chatBarPlaceholder')}
          className="flex-1"
          style={{
            height: 36, padding: '0 12px', fontSize: 13,
            color: MONO.t1, background: '#fff',
            border: '1px solid rgba(15,23,42,0.12)', borderRadius: 10, outline: 'none',
          }}
        />
        {running ? (
          <button
            onClick={() => useChatStore.getState().stopGeneration(activeSessionId)}
            className="shrink-0 transition-colors rounded-md"
            style={{
              height: 36, padding: '0 14px', fontSize: 12, color: '#DC2626',
              background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.4)',
              cursor: 'pointer',
            }}
          >
            {t('office.stopTask')}
          </button>
        ) : (
          <button
            onClick={send}
            className="shrink-0 transition-colors rounded-md"
            style={{
              width: 36, height: 36, fontSize: 14, color: '#fff',
              background: '#0058BC', cursor: 'pointer',
            }}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
