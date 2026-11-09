/**
 * 右栏上半：待决中心。
 *
 * 只放**真的需要用户点一下**的东西：工具审批、提问、预算触顶。数据全部来自
 * chatStore 的审批槽 / 提问槽 + 项目预算，动作全部是既有 store action
 *  （approveToolCall / rejectToolCall / setQuestionGate）；提问行不替用户选选项，
 * 只把用户送到那场对话（「去回答」）。
 *
 * ↑/↓ 移动选择，Enter 触发主行动。
 */
import { useEffect, useMemo, useState } from 'react'

import { OfficeRow, PanelLabel, QuietLine, TextAction, useRovingList } from './OfficeParts'
import type { OfficeViewModel } from './useOfficeView'

export default function PendingPanel({ view }: { view: OfficeViewModel }) {
  const rows = view.pending
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex((current) => (current >= keys.length ? 0 : current))
  }, [keys.length])

  const activate = (next: number) => {
    rows[next]?.primary()
  }
  const list = useRovingList({ length: rows.length, index, setIndex, onActivate: activate })

  return (
    <section className="shrink-0" aria-label="待决中心" data-testid="office-pending-panel">
      <PanelLabel trailing={rows.length > 0 ? `${rows.length} 件` : undefined}>待决中心</PanelLabel>

      {!view.connected ? (
        <QuietLine>未连接公司</QuietLine>
      ) : rows.length === 0 ? (
        <QuietLine>没有需要你决定的事</QuietLine>
      ) : (
        <div ref={list.containerRef} role="list" aria-label="待决列表" onKeyDown={list.onKeyDown}>
          {rows.map((row, i) => (
            <OfficeRow
              key={row.key}
              label={`${row.title}，${row.primaryLabel}`}
              selected={i === index}
              onSelect={() => setIndex(i)}
              // 点一下只选中；执行留给 Enter 或行内文字动作（审批不可误触）
              onActivate={() => setIndex(i)}
              className="py-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] leading-[19px] text-[var(--pure-ink)] truncate">{row.title}</span>
                <span className="ml-auto shrink-0 flex items-center gap-3">
                  <TextAction onClick={row.primary} title={row.primaryLabel}>
                    {row.primaryLabel}
                  </TextAction>
                  {row.secondary ? (
                    <TextAction onClick={row.secondary} title={row.secondaryLabel ?? undefined}>
                      {row.secondaryLabel}
                    </TextAction>
                  ) : null}
                </span>
              </div>
              <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-muted)] truncate" title={row.detail}>
                {row.detail}
              </div>
            </OfficeRow>
          ))}
        </div>
      )}
    </section>
  )
}
