/**
 * 一人公司 / Office 面（整窗）。由 shell 所有者挂载：
 *
 *   <OfficeSurface onClose={() => setOfficeOpen(false)} />
 *
 * 布局契约：
 *   44px 顶行（无描边）：公司名 · 状态词 · 目标模式开关 | 刷新 · 关闭
 *   三栏正常流：240 角色/工位 | flex-1 指标卡 + 任务流 | 400 待决中心 + 目标检查清单
 *
 * 三栏都是 flex 兄弟节点（不用绝对定位的面板）；分区只靠留白、字色与一条
 * 发丝线（右栏左边）。所有数字来自真实 store / service，缺失能力显示「未接入」。
 *
 * 键盘：三栏都是列表，↑/↓/Home/End 移动选择，Enter 打开 / 执行；Esc 关闭本面。
 */
import { useEffect, useRef } from 'react'

import '../pure.css'
import ChecklistPanel from './ChecklistPanel'
import MetricsRow from './MetricsRow'
import OfficeTopRow from './OfficeTopRow'
import { TextAction } from './OfficeParts'
import PendingPanel from './PendingPanel'
import RoleList from './RoleList'
import TaskFlow from './TaskFlow'
import { useOfficeView } from './useOfficeView'

export interface OfficeSurfaceProps {
  onClose: () => void
}

export default function OfficeSurface({ onClose }: OfficeSurfaceProps) {
  const view = useOfficeView(onClose)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  // 打开时把焦点交给左栏第一行：整窗面必须能只用键盘操作（不用 Tab 从头找）
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const active = document.activeElement
    if (active && active !== document.body && surface.contains(active)) return
    surface.querySelector<HTMLElement>('[data-office-row][tabindex="0"]')?.focus()
  }, [])

  // Esc 关闭：整窗面板必须能只用键盘退出
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      ref={surfaceRef}
      className="pure-shell h-full min-h-0 flex flex-col bg-[var(--pure-canvas)] overflow-hidden"
      data-testid="office-surface"
    >
      <OfficeTopRow view={view} onClose={onClose} />

      <div className="flex-1 min-h-0 flex">
        <RoleList view={view} />

        <main className="flex-1 min-w-0 min-h-0 flex flex-col px-5" aria-label="公司主区">
          {view.empty ? (
            <div className="flex items-baseline gap-3 pt-6">
              <span className="text-[12.5px] leading-[20px] text-[var(--pure-muted)]">{view.empty.text}</span>
              <TextAction onClick={view.empty.action} title={view.empty.actionLabel}>
                {view.empty.actionLabel}
              </TextAction>
            </div>
          ) : (
            <>
              <MetricsRow metrics={view.metrics} />
              <TaskFlow view={view} />
            </>
          )}
        </main>

        <aside
          className="w-[400px] shrink-0 min-h-0 flex flex-col border-l border-[var(--pure-border)] pl-5 pr-5 pb-4"
          aria-label="公司右栏"
          data-testid="office-right-column"
        >
          <PendingPanel view={view} />
          <ChecklistPanel view={view} />
        </aside>
      </div>
    </div>
  )
}
