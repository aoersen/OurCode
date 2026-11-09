/**
 * 左栏（240px）：角色 / 工位列表。
 *
 * 一行 = 一个工位：名称（13px ink）、当前任务一行（11.5px muted）、
 * 右侧运行点 / 待处理点 + 状态词。选中态浅灰底（--pure-active）。
 * ↑/↓ 移动选择，Enter 打开该工位会话（空缺工位 = 补齐编制）。
 *
 * 工位数据来自真实会话（workerRole/workerSlot）+ 最低编制 WORKER_ROSTER；
 * 编制内没有员工的工位显示「空缺」，不隐藏。
 */
import { useEffect, useMemo, useState } from 'react'

import { initialSelectionIndex } from './officeModel'
import { OfficeDot, OfficeRow, PanelLabel, QuietLine, TextAction, useRovingList } from './OfficeParts'
import type { OfficeViewModel } from './useOfficeView'

export default function RoleList({ view }: { view: OfficeViewModel }) {
  const rows = view.roles.rows
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const [index, setIndex] = useState(() => initialSelectionIndex(keys, view.roles.selectedKey))

  // 工位增删后把选择位收进范围（不重置用户的当前位置）
  useEffect(() => {
    setIndex((current) => (current >= keys.length ? Math.max(0, keys.length - 1) : current))
  }, [keys.length])

  const select = (next: number) => {
    setIndex(next)
    const row = rows[next]
    if (row) view.roles.select(row.key)
  }

  const activate = (next: number) => {
    const row = rows[next]
    if (!row) return
    if (row.sessionId) view.openSession(row.sessionId)
    else view.roles.ensureStaff()
  }

  const list = useRovingList({ length: rows.length, index, setIndex: select, onActivate: activate })

  return (
    <aside
      className="w-[240px] shrink-0 min-h-0 flex flex-col bg-[var(--pure-rail)] px-4 pt-1 pb-4"
      aria-label="角色与工位"
      data-testid="office-role-column"
    >
      <PanelLabel trailing={rows.length > 0 ? `在岗 ${view.roles.staffedCount}` : undefined}>角色 · 工位</PanelLabel>

      {rows.length === 0 ? (
        <div>
          <QuietLine>{view.connected ? '还没有工位 · 目标模式开工后自动补齐编制' : '未连接公司'}</QuietLine>
          {view.connected ? (
            <TextAction onClick={view.roles.ensureStaff} title="按最低编制补齐角色员工">
              补齐编制
            </TextAction>
          ) : null}
        </div>
      ) : (
        <div
          ref={list.containerRef}
          role="list"
          aria-label="工位列表"
          className="flex-1 min-h-0 overflow-y-auto pure-scroll pr-1"
          onKeyDown={list.onKeyDown}
        >
          {rows.map((row, i) => {
            const dot: 'running' | 'failed' | 'pending' | 'idle' = row.running
              ? 'running'
              : row.statusWord === '失败'
                ? 'failed'
                : row.pending > 0
                  ? 'pending'
                  : 'idle'
            return (
              <OfficeRow
                key={row.key}
                label={`${row.role}，${row.statusWord}，${row.taskLine}`}
                selected={i === index}
                onSelect={() => select(i)}
                onActivate={() => activate(i)}
                className="py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[13px] leading-[20px] truncate ${
                      row.staffed ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)]'
                    }`}
                  >
                    {row.role}
                  </span>
                  <span className="ml-auto shrink-0 flex items-center gap-1.5">
                    <OfficeDot state={dot} />
                    <span
                      className={`text-[11.5px] leading-[16px] ${
                        row.statusWord === '失败'
                          ? 'text-[var(--pure-danger)]'
                          : 'text-[var(--pure-muted)]'
                      }`}
                    >
                      {row.statusWord}
                    </span>
                  </span>
                </div>
                <div className="pt-0.5 text-[11.5px] leading-[16px] text-[var(--pure-muted)] truncate">
                  {row.taskLine}
                </div>
              </OfficeRow>
            )
          })}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="shrink-0 pt-2">
          <TextAction onClick={view.roles.ensureStaff} title="按最低编制补齐角色员工（幂等）">
            补齐编制
          </TextAction>
        </div>
      ) : null}
    </aside>
  )
}
