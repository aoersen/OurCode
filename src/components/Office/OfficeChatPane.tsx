/**
 * 底部对话条（V12 压缩版）：@角色 chips + 输入框 + 发送。
 *
 * 对话流（OfficeStream）与内嵌决策区（InlineDecisionArea）已移入中央工作台
 * 「对话」页签——本条只保留输入通道（发现项 #8：@角色定向发言，点名后工作台
 * 自动切到该角色）。保留 data-testid="office-chat-pane"（e2e 依赖）。
 */
import { useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { MONO } from './officeTheme'
import { IS_OFFICE } from '@/utils/windowMode'
import { isComposingEvent } from '@/utils/composition'

/** 目标模式 4 角色 chips（与 mapping.ROLE_LABELS 的 tm- 标签一致）。 */
const ROLE_CHIPS = ['需求分析', '研发', 'UI 开发', '测试']

export default function OfficeChatBar() {
  const t = useI18n()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const running = useChatStore(
    (s) => !!s.activeSessionId && s.runningSessionIds.includes(s.activeSessionId),
  )
  // 默认不选中任何角色：未点选时消息不带 @ 前缀，指令直接发给监管 Agent；
  // 需要定向派活时再点选（或直接在文本里输入 @角色）。
  const [chip, setChip] = useState<string | null>(null)
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

  const send = () => {
    const value = text.trim()
    if (!value) return
    // 定向目标解析：文本内 @角色 优先（同时切换 chip 与工作台角色）；
    // 否则用当前选中的 chip。文本内的 @角色 标记会被剥掉、统一由前缀表达，
    // 避免「已选 @研发 + 文本写 @需求分析」时拼出双前缀/前缀角色错乱。
    let target: string | null = chip
    for (const label of ROLE_CHIPS) {
      if (value.includes(`@${label}`)) {
        target = label
        if (chip !== label) setChip(label)
        useUIStore.getState().setOfficeSelectedRole(label)
        break
      }
    }
    const clean = target ? value.replace(new RegExp(`@${target}`, 'g'), '') : value
    const content = target ? `@${target} ${clean}`.trim() : value
    setText('')
    void useChatStore.getState().sendMessage(activeSessionId, content)
    inputRef.current?.focus()
  }

  const placeholder = chip
    ? t('office.chatBarPlaceholderChip', { role: chip })
    : t('office.chatBarPlaceholder')

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
      {/* @角色 chips：点选 = 定向派活（消息自动带 @前缀，监管优先派给该角色）；
          不选 = 指令直接发给监管。title 逐角色说明，行首常驻提示让新用户
          一眼知道 @ 的用途。 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {chip === null && (
          <span
            className="shrink-0 rounded-full px-2 py-0.5"
            style={{
              fontSize: 10, color: MONO.t3, background: 'rgba(15,23,42,0.04)',
              border: `1px dashed ${MONO.hairline}`, lineHeight: 1.6,
            }}
          >
            {t('office.chipHint')}
          </span>
        )}
        {ROLE_CHIPS.map((label) => (
          <button
            key={label}
            onClick={() => {
              setChip(chip === label ? null : label)
              useUIStore.getState().setOfficeSelectedRole(chip === label ? null : label)
            }}
            title={t('office.chipTitle', { role: label })}
            className="transition-colors rounded-full"
            style={{
              fontSize: 12, padding: '2px 11px', lineHeight: 1.6,
              color: chip === label ? '#0058BC' : MONO.t2,
              background: chip === label ? 'rgba(0,88,188,0.08)' : MONO.bg,
              border: `1px solid ${chip === label ? 'rgba(0,88,188,0.35)' : MONO.hairline}`,
              cursor: 'pointer',
            }}
          >
            @{label}
          </button>
        ))}
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
          placeholder={placeholder}
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
