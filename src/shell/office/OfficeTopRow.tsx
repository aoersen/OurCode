/**
 * 顶行（44px，无描边）：公司名 + 状态词 + 目标模式开关；右侧 刷新 / 关闭。
 *
 * 目标模式开关接的是真入口：chatStore.setTargetMode(sessionId, enabled)
 * —— 开的时候会顺带 bootstrap `.ourcode/targemode/` 骨架并弹首次提示（既有行为）。
 * 没有可挂的会话时开关是 disabled 的只读状态，不假装能开。
 */
import type { OfficeViewModel } from './useOfficeView'
import { TextAction } from './OfficeParts'

interface OfficeTopRowProps {
  view: OfficeViewModel
  onClose: () => void
}

export default function OfficeTopRow({ view, onClose }: OfficeTopRowProps) {
  const { goalMode } = view
  const switchTitle = goalMode.available
    ? goalMode.on
      ? '关闭目标模式（停止总监自动续跑）'
      : '开启目标模式：总监 + 工位协作，按轮次推进目标'
    : '先创建或选择一个会话，才能挂目标模式'

  return (
    <header className="shrink-0 h-11 flex items-center gap-3 px-5" data-testid="office-top-row">
      <span
        className="text-[13px] leading-[20px] text-[var(--pure-ink)] font-medium truncate max-w-[220px]"
        title={view.company.projectPath ?? undefined}
      >
        {view.company.name}
      </span>

      <span className="text-[12px] leading-[18px] text-[var(--pure-muted)] shrink-0" data-testid="office-status-word">
        {view.status.word}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={goalMode.on}
        aria-label="目标模式"
        disabled={!goalMode.available}
        onClick={goalMode.toggle}
        title={switchTitle}
        data-testid="office-goal-mode-toggle"
        className={`pure-focus inline-flex items-center gap-1.5 text-[12px] leading-[18px] transition-colors disabled:opacity-40 ${
          goalMode.on
            ? 'text-[var(--pure-ink)]'
            : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
        }`}
      >
        目标模式
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            goalMode.on ? 'bg-[var(--pure-ink)]' : 'border border-[var(--pure-muted)] bg-transparent'
          }`}
          aria-hidden
        />
      </button>

      <span className="ml-auto flex items-center gap-4">
        <TextAction onClick={view.refresh} title="重新读取目标清单与实施状态">
          刷新
        </TextAction>
        <TextAction onClick={onClose} title="关闭一人公司">
          关闭
        </TextAction>
      </span>
    </header>
  )
}
