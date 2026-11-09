/**
 * 主区任务流：每行 角色 · 任务 · 状态词 · 时间，悬停显示「打开会话」。
 *
 * 数据来自 buildDirectorActivities（总监派发 / 员工子智能体 / 总监本会话子智能体），
 * 全部带真实时间戳；没有任何活动时给安静的空态 + 一个文字动作。
 * ↑/↓ 移动选择，Enter 打开会话（员工会话对用户隐藏 → 统一打开总监会话）。
 */
import { useEffect, useMemo, useState } from 'react'

import { formatClock } from './officeModel'
import { OfficeRow, PanelLabel, QuietLine, TextAction, useRovingList } from './OfficeParts'
import type { OfficeViewModel } from './useOfficeView'

export default function TaskFlow({ view }: { view: OfficeViewModel }) {
  const rows = view.tasks.rows
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex((current) => (current >= keys.length ? 0 : current))
  }, [keys.length])

  const open = (next: number) => {
    const row = rows[next]
    if (!row) return
    view.openSession(row.sessionId ?? view.tasks.directorSessionId)
  }

  const list = useRovingList({ length: rows.length, index, setIndex, onActivate: open })
  const now = Date.now()

  return (
    <section className="flex-1 min-h-0 flex flex-col pt-5" aria-label="任务流" data-testid="office-task-flow">
      <PanelLabel
        trailing={
          rows.length > 0
            ? `${view.tasks.counts.running} 运行中 · ${view.tasks.counts.done} 已完成${
                view.tasks.counts.failed > 0 ? ` · ${view.tasks.counts.failed} 失败` : ''
              }`
            : undefined
        }
      >
        任务流
      </PanelLabel>

      {view.tasks.hasDirector && view.tasks.directorTitle ? (
        <div className="pb-1 flex items-baseline gap-2">
          <span className="text-[12.5px] leading-[19px] text-[var(--pure-ink)] truncate">
            {view.tasks.directorTitle}
          </span>
          <TextAction onClick={() => view.openSession(view.tasks.directorSessionId)} title="打开总监会话">
            打开会话
          </TextAction>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="pt-1">
          <QuietLine>
            {view.tasks.hasDirector
              ? '还没有角色活动 · 总监派活或启动子智能体后出现在这里'
              : view.connected
                ? '总监还没开始干活'
                : '未连接公司'}
          </QuietLine>
          {view.tasks.hasDirector ? (
            <TextAction onClick={() => view.openSession(view.tasks.directorSessionId)} title="打开总监会话">
              打开会话
            </TextAction>
          ) : null}
        </div>
      ) : (
        <div
          ref={list.containerRef}
          role="list"
          aria-label="任务流列表"
          className="flex-1 min-h-0 overflow-y-auto pure-scroll pr-1"
          onKeyDown={list.onKeyDown}
        >
          {rows.map((row, i) => (
            <OfficeRow
              key={row.key}
              label={`${row.role}，${row.task}，${row.statusWord}`}
              selected={i === index}
              onSelect={() => setIndex(i)}
              onActivate={() => open(i)}
              className="flex items-baseline gap-3 py-1.5"
            >
              <span className="w-[104px] shrink-0 text-[12.5px] leading-[19px] text-[var(--pure-ink)] truncate">
                {row.role}
              </span>
              <span className="flex-1 min-w-0 text-[12.5px] leading-[19px] text-[var(--pure-secondary)] truncate">
                {row.task}
              </span>
              <span
                className={`w-[56px] shrink-0 text-right text-[11.5px] leading-[18px] ${
                  row.status === 'failed' ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'
                }`}
              >
                {row.statusWord}
              </span>
              <span className="w-[72px] shrink-0 text-right text-[11.5px] leading-[18px] text-[var(--pure-muted)] tabular-nums">
                {formatClock(row.at, now)}
              </span>
              <span className="w-[56px] shrink-0 text-right pure-row-actions">
                <TextAction onClick={() => view.openSession(row.sessionId ?? view.tasks.directorSessionId)} title="打开会话">
                  打开会话
                </TextAction>
              </span>
            </OfficeRow>
          ))}
        </div>
      )}
    </section>
  )
}
