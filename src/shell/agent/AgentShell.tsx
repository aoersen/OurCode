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
 *
 * 竖直方向：顶栏 → 滚动区（消息 + 吸顶状态气泡） → 底栏（决策卡 + composer）。
 * 滚动区在底栏上沿结束，因此 composer 永远不会压住内容。
 */
export default function AgentShell() {
  const isArtifactPanelOpen = useUIStore((s) => s.isArtifactPanelOpen)

  return (
    <div className="pure-shell h-full min-h-0 flex overflow-hidden bg-white">
      <SessionRail />

      <div className="flex-1 min-w-0 min-h-0 flex">
        <section className="relative flex-1 min-w-0 min-h-0 flex flex-col">
          <ConversationHeader />
          <ConversationView />
          <BottomDock />
        </section>

        {isArtifactPanelOpen && <ArtifactPanel />}
      </div>

      <AgentOverlays />
    </div>
  )
}
