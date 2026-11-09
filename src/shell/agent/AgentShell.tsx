import { useEffect, useState } from 'react'
import SessionRail from './SessionRail'
import ConversationHeader from './ConversationHeader'
import ConversationView from './ConversationView'
import BottomDock from './BottomDock'
import ArtifactPanel from './ArtifactPanel'
import AgentOverlays from './AgentOverlays'
import { useUIStore } from '@/stores/uiStore'
// 让任何渲染入口（真实应用 / __preview__ 截图沙盘）都能拿到 pure 令牌
import '../pure.css'

/**
 * 对话优先主壳。
 *
 * 布局契约（与 Stitch 设计稿一致，且是唯一允许的布局方式）：
 *   260 会话栏（项目树） | 720 阅读列（居中，flex-1） | 400 产物栏（默认关）
 * 三栏都是 flex 兄弟节点 —— 不允许 overlay、不允许绝对定位的面板。
 * 唯一例外：窄窗（< 1024）时产物栏改为覆盖式抽屉（见 pure.css .pure-narrow-drawer），
 * 因为 400px 面板在 1024 以下没有并排空间；点背景即关。
 *
 * 竖直方向：顶栏 → 滚动区（消息 + 吸顶状态气泡） → 底栏（决策卡 + composer）。
 * 滚动区在底栏上沿结束，因此 composer 永远不会压住内容。
 */
export default function AgentShell() {
  const isArtifactPanelOpen = useUIStore((s) => s.isArtifactPanelOpen)
  const setArtifactPanelOpen = useUIStore((s) => s.setArtifactPanelOpen)
  const setRailCollapsed = useUIStore((s) => s.setRailCollapsed)

  const [width, setWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  )

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const narrow = width < 1024

  // 窄窗里左栏默认收起：先把宽度让给对话列，用户仍可从图标条展开。
  useEffect(() => {
    if (narrow) setRailCollapsed(true)
  }, [narrow, setRailCollapsed])

  return (
    <div className="pure-shell h-full min-h-0 flex overflow-hidden bg-[var(--pure-canvas)]">
      <SessionRail />

      <div className="relative flex-1 min-w-0 min-h-0 flex">
        <section className="relative flex-1 min-w-0 min-h-0 flex flex-col">
          <ConversationHeader />
          <ConversationView />
          <BottomDock />
        </section>

        {isArtifactPanelOpen && narrow && (
          <>
            {/* 背景遮罩：点它关闭抽屉（键盘用户用 Esc / 面板内的关闭按钮）。
                之前是全透明，窄窗里看不出「这是浮层」，对话正文会像被切掉。 */}
            <button
              type="button"
              aria-label="关闭文档面板"
              onClick={() => setArtifactPanelOpen(false)}
              className="pure-drawer-backdrop absolute inset-0 z-20 cursor-default"
              tabIndex={-1}
            />
            <div className="pure-narrow-drawer w-[400px] max-w-[92vw] flex">
              <ArtifactPanel />
            </div>
          </>
        )}

        {isArtifactPanelOpen && !narrow && <ArtifactPanel />}
      </div>

      <AgentOverlays />
    </div>
  )
}
