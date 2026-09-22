import { useState } from 'react'
import CompanyPanel from './CompanyPanel'
import CompanyDashboard from './CompanyDashboard'
import OfficeProjectsPanel from './OfficeProjectsPanel'
import OfficeChatPane from './OfficeChatPane'
import OfficeWorkbench from './OfficeWorkbench'
import OfficeTopBar from './OfficeTopBar'
import GoalChecklistCard from './GoalChecklistCard'
import PendingCenterCard from './PendingCenterCard'
import ArtifactsCard from './ArtifactsCard'
import { MONO } from './officeTheme'
import { useI18n } from '@/i18n/useI18n'

/** Tab 条高度（收起后大框只保留这一行）。 */
const TAB_BAR_H = 40
/** 上（看板/场景）占中央列高度的比例范围与默认值（V12：场景为氛围层 ≤40%）。 */
const RATIO_MIN = 0.15
const RATIO_MAX = 0.6
const RATIO_DEFAULT = 0.4
const RATIO_KEY = 'office.sceneRatio'
const COLLAPSED_KEY = 'office.topCollapsed'

function loadRatio(): number {
  const v = parseFloat(localStorage.getItem(RATIO_KEY) || '')
  return Number.isFinite(v) ? Math.max(RATIO_MIN, Math.min(RATIO_MAX, v)) : RATIO_DEFAULT
}

/**
 * 「一人公司」视图（V12 信任闭环三栏版）：
 * 顶部状态条（人话徽章/待决铃铛/预算/停止）
 *  + 左栏「项目/任务」
 *  + 中央列（上=看板/3D 场景 Tab，可拖拽比例、可收起；下=实时工作台 4 页签）
 *  + 右栏（目标达成 / 待决中心 / 产出物 三卡）
 *  + 底部对话条（@角色 chips + 输入）
 * 对话流（OfficeStream + 审批区）在工作台「对话」页签内。
 */
export default function OfficeView() {
  const t = useI18n()
  // 上公司面板 / 工作台 的分割比例；拖拽后持久化，重启不重置
  const [sceneRatio, setSceneRatioState] = useState(loadRatio)
  // 右上区域 tab：看板 / 场景（3D）
  const [activeTopTab, setActiveTopTab] = useState<'dashboard' | 'scene'>('dashboard')
  // 「看板/场景」大框整体收起：只留 Tab 条，工作台吃满剩余空间
  const [topCollapsed, setTopCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')

  const setSceneRatio = (ratio: number) => {
    setSceneRatioState(ratio)
    try { localStorage.setItem(RATIO_KEY, String(ratio)) } catch { /* ignore */ }
  }
  const toggleCollapsed = () => {
    setTopCollapsed((c) => {
      const next = !c
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  // 公司面板 / 工作台 上下分割拖拽
  const onSceneResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const resizer = e.target as HTMLElement
    const column = resizer.parentElement
    const topPane = resizer.previousElementSibling as HTMLElement | null
    if (!column || !topPane) return
    const startY = e.clientY
    const startSize = topPane.offsetHeight
    const parentSize = column.offsetHeight
    const handleMove = (ev: MouseEvent) => {
      const ratio = (startSize + (ev.clientY - startY)) / parentSize
      setSceneRatio(Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio)))
    }
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }

  return (
    <div id="office3d-root" className="flex flex-col h-full min-h-0">
      {/* 顶部状态条 */}
      <OfficeTopBar />

      <div className="flex flex-1 min-h-0">
        {/* 左栏：项目 / 任务 */}
        <OfficeProjectsPanel />

        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* 中央列 + 右栏 */}
          <div className="flex flex-1 min-h-0">
            {/* 中央列：上（看板/场景）+ 下（工作台） */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <div
                className="flex flex-col min-h-0 overflow-hidden"
                style={{ flex: topCollapsed ? `0 0 ${TAB_BAR_H}px` : `0 0 ${sceneRatio * 100}%` }}
              >
                {/* Tab 切换条 + 右侧收起/展开按钮 */}
                <div
                  className="shrink-0 flex items-center px-5"
                  style={{ height: TAB_BAR_H, background: MONO.bg, borderBottom: `1px solid ${MONO.hairline}`, gap: 24 }}
                >
                  {(['dashboard', 'scene'] as const).map((tab) => {
                    const active = activeTopTab === tab
                    return (
                      <button
                        key={tab}
                        onClick={() => setActiveTopTab(tab)}
                        className="transition-colors"
                        style={{
                          display: 'flex', alignItems: 'center', height: '100%', marginBottom: -1,
                          padding: '0 2px',
                          fontSize: 13, fontWeight: active ? 500 : 400,
                          color: active ? MONO.t1 : MONO.t3,
                          background: 'transparent', border: 'none',
                          borderBottom: `2px solid ${active ? MONO.ink : 'transparent'}`,
                          cursor: 'pointer',
                        }}
                      >
                        {tab === 'dashboard' ? t('office.dashboard') : t('office.scene')}
                      </button>
                    )
                  })}
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
                {/* Tab 内容：常驻挂载，用 display 切换，避免 3D 场景反复初始化 */}
                <div
                  className="flex-1 min-h-0 overflow-hidden relative"
                  style={{ display: topCollapsed ? 'none' : undefined }}
                >
                  <div className="absolute inset-0" style={{ display: activeTopTab === 'scene' ? 'block' : 'none' }}>
                    <CompanyPanel visible={activeTopTab === 'scene' && !topCollapsed} />
                  </div>
                  <div className="absolute inset-0" style={{ display: activeTopTab === 'dashboard' ? 'block' : 'none' }}>
                    <CompanyDashboard active={activeTopTab === 'dashboard' && !topCollapsed} />
                  </div>
                </div>
              </div>
              {!topCollapsed && (
                <div
                  className="h-px shrink-0 cursor-row-resize transition-colors hover:bg-black/20"
                  style={{ background: MONO.hairline }}
                  onMouseDown={onSceneResize}
                />
              )}
              {/* 实时工作台（选中角色驱动） */}
              <OfficeWorkbench />
            </div>

            {/* 右栏：目标达成 / 待决中心 / 产出物 */}
            <div
              className="w-[300px] shrink-0 flex flex-col gap-2.5 p-2.5 overflow-y-auto"
              style={{ borderLeft: '1px solid rgba(15,23,42,0.08)' }}
            >
              <GoalChecklistCard active />
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
