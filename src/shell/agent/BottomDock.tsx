import ApprovalsDock from './approvals/ApprovalsDock'
import Composer from './composer/Composer'
import { useIsEmptyConversation } from './composer/useComposer'

/**
 * 底部 dock：决策卡 + composer，同一个 in-flow 容器。
 *
 * 这是设计稿里被反复验证过的一条：composer 绝不浮动、绝不绝对定位，
 * 否则滚动区末尾的内容一定会被压住。滚动区在 dock 上沿结束。
 *
 * 决策卡由 `approvals/ApprovalsDock` 统一渲染：单条工具审批、批量审批、计划审批、
 * 计划外写入拦截、澄清提问（含确认门槛条）、重新生成 / 回退全部确认，全都复用
 * 同一种卡片解剖，没有弹窗、没有遮罩。空会话时 composer 在 `ConversationView`
 * 的 hero 位（居中偏上），这里只留决策卡，避免同一条草稿出现两个输入框。
 */
export default function BottomDock() {
  const empty = useIsEmptyConversation()

  return (
    <div className="shrink-0 w-full px-6 pt-2 pb-3 border-t border-[var(--pure-border)] bg-[var(--pure-canvas)]">
      <div data-testid="composer-dock" className="mx-auto w-full max-w-[720px] flex flex-col gap-2">
        <ApprovalsDock />
        {!empty && <Composer variant="inline" />}
      </div>
    </div>
  )
}
