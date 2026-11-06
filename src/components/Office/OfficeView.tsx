import { useCallback, useEffect, useRef, useState } from 'react'
import CompanyDashboard from './CompanyDashboard'
import OfficeProjectsPanel from './OfficeProjectsPanel'
import OfficeChatPane from './OfficeChatPane'
import OfficeWorkbench from './OfficeWorkbench'
import OfficeTopBar from './OfficeTopBar'
import GoalChecklistCard from './GoalChecklistCard'
import PendingCenterCard from './PendingCenterCard'
import CheckpointCenterCard from './CheckpointCenterCard'
import ArtifactsCard from './ArtifactsCard'
import { MONO } from './officeTheme'
import { useI18n } from '@/i18n/useI18n'
import { useElementSize } from '@/hooks/useElementSize'
import {
  TAB_BAR_H,
  HANDLE_H,
  WORKBENCH_MIN_H,
  DEFAULT_BOARD_RATIO,
  HEIGHT_STEP,
  HEIGHT_STEP_LARGE,
  adjustBoardHeight,
  clampBoardHeight,
  resolveBoardBounds,
  resolveBoardHeight,
} from '@/services/office/dashboardLayout'

/** 看板高度的持久化键（像素）。 */
const HEIGHT_KEY = 'office.dashboardHeight'
/** 旧版比例持久化键：只用于一次性迁移，新版本不再写入。 */
const LEGACY_RATIO_KEY = 'office.sceneRatio'
const COLLAPSED_KEY = 'office.topCollapsed'

function readStoredHeight(): number | null {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY)
    const v = raw == null ? NaN : parseFloat(raw)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function readLegacyRatio(): number {
  try {
    const v = parseFloat(localStorage.getItem(LEGACY_RATIO_KEY) || '')
    return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_BOARD_RATIO
  } catch {
    return DEFAULT_BOARD_RATIO
  }
}

function persistHeight(h: number | null): void {
  try {
    if (h == null) localStorage.removeItem(HEIGHT_KEY)
    else localStorage.setItem(HEIGHT_KEY, String(Math.round(h)))
  } catch {
    /* localStorage 不可用时只是不持久化，不影响本次拖动 */
  }
}

/**
 * 「一人公司」视图（信任闭环三栏版）：
 * 顶部状态条（人话徽章/待决铃铛/预算/停止）
 *  + 左栏「项目/任务」
 *  + 中央列（上=看板，可拖拽高度、可收起；下=实时工作台 4 页签）
 *  + 右栏（目标达成 / 待决中心 / 产出物 三卡）
 *  + 底部对话条（@角色 chips + 输入）
 * 对话流（OfficeStream + 审批区）在工作台「对话」页签内。
 *
 * 分栏高度（本次修复）：
 * - 像素模型 + 动态边界：看板保底 264px、工作台保底 180px，装不下时看板内部
 *   滚动而不是被压扁（旧的 `15%~60%` 百分比会让看板在矮窗口里只剩几十像素，
 *   三栏滚动区高度归零 → 「显示不全」）；
 * - 分割条命中区从 1px 加到 10px（视觉仍是 1px 发丝线，悬停/拖动高亮成主色），
 *   并支持指针拖拽、方向键 / PgUp PgDn / Home End 调高、双击复位。
 */
export default function OfficeView() {
  const t = useI18n()

  // 上看板 / 工作台 分割：像素高度，拖拽后持久化，重启沿用
  const [storedHeight, setStoredHeight] = useState<number | null>(readStoredHeight)
  // 看板大框整体收起：只留标题条，工作台吃满剩余空间
  const [topCollapsed, setTopCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [dragging, setDragging] = useState(false)
  const [handleHover, setHandleHover] = useState(false)

  // 中央列高度 → 推出可用高度（扣掉分割条；收起时没有分割条）
  const columnRef = useRef<HTMLDivElement>(null)
  const { height: columnHeight } = useElementSize(columnRef)
  const available = columnHeight > 0 ? Math.max(0, columnHeight - (topCollapsed ? 0 : HANDLE_H)) : 0
  const availableRef = useRef(available)
  availableRef.current = available

  const preferredRatio = useRef(readLegacyRatio()).current
  const boardHeight = resolveBoardHeight(available, storedHeight, preferredRatio)
  const bounds = resolveBoardBounds(available)
  // 拖动/键盘回调里读最新值，避免闭包拿到旧的 boardHeight
  const boardHeightRef = useRef(boardHeight)
  boardHeightRef.current = boardHeight

  const applyHeight = useCallback((h: number, save: boolean) => {
    setStoredHeight(h)
    if (save) persistHeight(h)
  }, [])

  const resetHeight = useCallback(() => {
    setStoredHeight(null)
    persistHeight(null)
    try {
      localStorage.removeItem(LEGACY_RATIO_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleCollapsed = () => {
    setTopCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // ── 分割条拖拽（指针事件，命中区 10px） ─────────────────────────────────
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startH = boardHeightRef.current
    setDragging(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (ev: PointerEvent) => {
      const next = adjustBoardHeight(startH, ev.clientY - startY, availableRef.current)
      boardHeightRef.current = next
      setStoredHeight(next)
    }
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
      // 拖动过程只更新内存，松手才落盘，避免写入风暴
      persistHeight(boardHeightRef.current)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }

  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cur = boardHeightRef.current
    let next: number | null = null
    if (e.key === 'ArrowUp') next = cur - HEIGHT_STEP
    else if (e.key === 'ArrowDown') next = cur + HEIGHT_STEP
    else if (e.key === 'PageUp') next = cur - HEIGHT_STEP_LARGE
    else if (e.key === 'PageDown') next = cur + HEIGHT_STEP_LARGE
    else if (e.key === 'Home') next = bounds.min
    else if (e.key === 'End') next = bounds.max
    if (next == null) return
    e.preventDefault()
    applyHeight(clampBoardHeight(next, available), true)
  }

  // 窗口/面板尺寸变化后把越界的持久化值回落，避免下次打开仍是「压扁的高度」
  useEffect(() => {
    if (available <= 0 || storedHeight == null) return
    const clamped = clampBoardHeight(storedHeight, available)
    if (clamped !== Math.round(storedHeight)) setStoredHeight(clamped)
  }, [available, storedHeight])

  const handleActive = dragging || handleHover

  // 工作台下限不能把中央列撑破：极矮窗口里按剩余空间收缩（否则工作台底部被裁掉）。
  const boardOccupied = topCollapsed ? TAB_BAR_H : boardHeight
  const workbenchMin = available > 0
    ? Math.max(0, Math.min(WORKBENCH_MIN_H, available - boardOccupied))
    : 0

  return (
    <div id="office-root" className="flex flex-col h-full min-h-0">
      {/* 顶部状态条 */}
      <OfficeTopBar />

      <div className="flex flex-1 min-h-0">
        {/* 左栏：项目 / 任务 */}
        <OfficeProjectsPanel />

        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* 中央列 + 右栏 */}
          <div className="flex flex-1 min-h-0">
            {/* 中央列：上（看板）+ 下（工作台） */}
            <div ref={columnRef} className="flex-1 flex flex-col min-h-0 min-w-0">
              <div
                className="flex flex-col min-h-0 overflow-hidden"
                style={{
                  // 像素高度（收起时只留标题条）；不参与 flex 伸缩，
                  // 剩余空间全部交给工作台，拖多少就是多少。
                  flex: '0 0 auto',
                  height: topCollapsed ? TAB_BAR_H : boardHeight,
                }}
              >
                {/* 标题条 + 右侧收起/展开按钮 */}
                <div
                  className="shrink-0 flex items-center px-5"
                  style={{ height: TAB_BAR_H, background: MONO.bg, borderBottom: `1px solid ${MONO.hairline}`, gap: 24 }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, color: MONO.t1 }}>{t('office.dashboard')}</span>
                  <button
                    onClick={toggleCollapsed}
                    title={topCollapsed ? t('office.expandPanel') : t('office.collapsePanel')}
                    className="transition-colors"
                    style={{
                      marginLeft: 'auto',
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 6,
                      fontSize: 11.5, color: MONO.t3,
                      background: 'transparent', border: `1px solid ${MONO.hairline}`,
                      cursor: 'pointer',
                    }}
                  >
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: topCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                    >
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                    {topCollapsed ? t('office.expandPanel') : t('office.collapsePanel')}
                  </button>
                </div>
                {/* 看板内容 */}
                <div
                  className="flex-1 min-h-0 overflow-hidden relative"
                  style={{ display: topCollapsed ? 'none' : undefined }}
                >
                  <div className="absolute inset-0">
                    <CompanyDashboard active={!topCollapsed} />
                  </div>
                </div>
              </div>
              {!topCollapsed && (
                /* 分割条：视觉 1px 发丝线，命中区 10px（原来 h-px 基本抓不住）。
                   悬停 / 拖动时发丝线变主色并加粗，明确「这里能拖」。 */
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={t('office.resizeHandle')}
                  aria-valuemin={bounds.min}
                  aria-valuemax={bounds.max}
                  aria-valuenow={Math.round(boardHeight)}
                  tabIndex={0}
                  title={t('office.resizeHint')}
                  onPointerDown={onHandlePointerDown}
                  onKeyDown={onHandleKeyDown}
                  onDoubleClick={resetHeight}
                  onMouseEnter={() => setHandleHover(true)}
                  onMouseLeave={() => setHandleHover(false)}
                  className="shrink-0 flex items-center justify-center cursor-row-resize outline-none"
                  style={{
                    height: HANDLE_H,
                    background: handleActive ? 'rgba(0,88,188,0.06)' : 'transparent',
                    touchAction: 'none',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      width: '100%',
                      height: handleActive ? 2 : 1,
                      borderRadius: 999,
                      background: handleActive ? '#0058bc' : MONO.hairline,
                      transition: 'height 0.12s, background 0.12s',
                    }}
                  />
                </div>
              )}
              {/* 实时工作台（选中角色驱动）——保底高度，装不下时看板滚动而不是压扁工作台 */}
              <div className="flex-1 min-h-0 flex flex-col" style={{ minHeight: workbenchMin }}>
                <OfficeWorkbench />
              </div>
            </div>

            {/* 右栏：目标达成 / 待决中心 / 产出物 */}
            <div
              className="w-[300px] shrink-0 flex flex-col gap-2.5 p-2.5 overflow-y-auto"
              style={{ borderLeft: '1px solid rgba(15,23,42,0.08)' }}
            >
              <GoalChecklistCard active />
              <CheckpointCenterCard active />
              <PendingCenterCard active />
              <ArtifactsCard active />
            </div>
          </div>

          {/* 底部对话条 */}
          <OfficeChatPane />
        </div>
      </div>
    </div>
  )
}
