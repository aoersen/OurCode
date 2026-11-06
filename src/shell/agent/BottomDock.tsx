import InlineDecisionArea from '@/components/ChatPanel/InlineDecisionArea'
import Composer from './composer/Composer'
import { useIsEmptyConversation } from './composer/useComposer'

/**
 * 底部 dock：决策卡 + composer，同一个 in-flow 容器。
 *
 * 这是设计稿里被反复验证过的一条：composer 绝不浮动、绝不绝对定位，
 * 否则滚动区末尾的内容一定会被压住。滚动区在 dock 上沿结束。
 *
 * 空会话时 composer 在 `ConversationView` 的 hero 位（居中偏上），这里只留决策卡，
 * 避免同一条草稿出现两个输入框。
 */
export default function BottomDock() {
  const empty = useIsEmptyConversation()

  return (
    <div className="shrink-0 w-full px-6 pt-1 pb-3">
      <div data-testid="composer-dock" className="mx-auto w-full max-w-[720px] flex flex-col gap-2">
        <InlineDecisionArea />
        {!empty && <Composer variant="inline" />}
      </div>
    </div>
  )
}
