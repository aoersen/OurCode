/**
 * 右栏下半：目标检查清单。
 *
 * 阶段行（`阶段 3/5` · `第 2 轮`）+ 每项 ✓ / … / ○ + `n/m` 计数 + 覆盖率。
 * 数据来自 `.ourcode/targemode/finalGoal.md` 与最近一轮 `comparison.md`
 * （readGoalChecklist / readStatus）。没有清单时给安静空态。
 *
 * ↑/↓ 移动选择，Enter 打开总监会话（清单的家就在那场对话里）。
 */
import { useEffect, useMemo, useState } from 'react'

import { OfficeRow, PanelLabel, QuietLine, useRovingList } from './OfficeParts'
import type { OfficeViewModel } from './useOfficeView'

export default function ChecklistPanel({ view }: { view: OfficeViewModel }) {
  const rows = view.checklist.rows
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex((current) => (current >= keys.length ? 0 : current))
  }, [keys.length])

  const open = () => view.openSession(view.tasks.directorSessionId)
  const list = useRovingList({ length: rows.length, index, setIndex, onActivate: open })

  const metaLine =
    [view.checklist.stage, view.checklist.round, view.checklist.liveText].filter(Boolean).join(' · ') ||
    '清单已就绪'

  return (
    <section className="flex-1 min-h-0 flex flex-col pt-5" aria-label="目标检查清单" data-testid="office-checklist-panel">
      <PanelLabel trailing={rows.length > 0 ? view.checklist.countText : undefined}>目标检查清单</PanelLabel>

      {!view.connected ? (
        <QuietLine>未连接公司</QuietLine>
      ) : rows.length === 0 ? (
        <div>
          <QuietLine>还没有目标清单 · 目标模式开工后生成 finalGoal.md</QuietLine>
        </div>
      ) : (
        <>
          <div className="pb-1 text-[11.5px] leading-[18px] text-[var(--pure-muted)] truncate" title={metaLine}>
            {metaLine}
          </div>
          <div
            ref={list.containerRef}
            role="list"
            aria-label="检查清单条目"
            className="flex-1 min-h-0 overflow-y-auto pure-scroll pr-1"
            onKeyDown={list.onKeyDown}
          >
            {rows.map((row, i) => (
              <OfficeRow
                key={row.key}
                label={`${row.mark} ${row.text}`}
                selected={i === index}
                onSelect={() => setIndex(i)}
                onActivate={open}
                className="flex items-baseline gap-2 py-1"
              >
                <span
                  className={`w-3 shrink-0 text-[12px] leading-[19px] text-center ${
                    row.state === 'done' ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)]'
                  }`}
                  aria-hidden
                >
                  {row.mark}
                </span>
                <span
                  className={`flex-1 min-w-0 text-[12.5px] leading-[19px] truncate ${
                    row.state === 'todo' ? 'text-[var(--pure-secondary)]' : 'text-[var(--pure-ink)]'
                  }`}
                  title={row.text}
                >
                  {row.text}
                </span>
              </OfficeRow>
            ))}
          </div>
          <div className="shrink-0 pt-2 text-[11.5px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
            覆盖率 {view.checklist.progress.percent}%
          </div>
        </>
      )}
    </section>
  )
}
