import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'

interface ThinkingSectionProps {
  /** 该轮次的思考文本（流式或已提交） */
  thinking?: string
  /** 运行/流式期间自动展开，输出结束后自动收起；用户手动点过折叠头/收起按钮
   *  后一切以用户为准（不再自动展开）。默认收起 */
  defaultExpanded?: boolean
  /** 流式进行中：收起状态下显示「思考中…」脉冲提示而不是首行预览，
   *  避免把内心独白刷屏给用户看；点击仍可展开查看。 */
  streaming?: boolean
}

/**
 * 单轮思考块 —— 最小化可折叠行，随真实调用顺序交错在正文流中
 * （思考 → 文字 → 工具 → 思考 → 文字 → 工具）。
 * 收起时只留「💭 思考 + 首行预览」，展开后显示完整思考文本。
 */
export default function ThinkingSection({ thinking, defaultExpanded = false, streaming = false }: ThinkingSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const t = useI18n()
  // 用户是否手动点过折叠头/收起按钮 —— 点过之后一切以用户为准，不再自动开合。
  const userToggledRef = useRef(false)
  // 是否已经历过一次「运行结束」：结束后自动收起，且之后的运行不再自动展开。
  const settledRef = useRef(false)

  // 输出期间自动展开，输出结束后自动收起；用户手动点过后以用户为准。
  useEffect(() => {
    if (userToggledRef.current || settledRef.current) return
    if (defaultExpanded) {
      setIsExpanded(true)
    } else {
      settledRef.current = true
      setIsExpanded(false)
    }
  }, [defaultExpanded])

  if (!thinking) return null

  const toggle = () => {
    userToggledRef.current = true
    setIsExpanded((v) => !v)
  }

  const collapse = () => {
    userToggledRef.current = true
    setIsExpanded(false)
  }

  return (
    /* 思考区 —— 无大框：一行「图标 + 标题 + 箭头」折叠头；收起时思考全部
       收进去；展开时正文 → 底部 hairline → 「收起」按钮，让用户知道上面
       是什么。样式对齐 code.html 的 thinking 区。 */
    <div className="text-sm">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 px-1.5 py-1 text-left cursor-pointer select-none group rounded-md hover:bg-nova-hover/60 transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0 text-nova-text-muted">
          <span className="material-symbols-outlined text-[15px] leading-none shrink-0" aria-hidden>
            psychology
          </span>
          <span className="text-[11px] uppercase tracking-[0.05em] font-semibold shrink-0">{t('chat.thinkingTitle')}</span>
          {streaming && !isExpanded && (
            <span className="inline-flex gap-0.5 shrink-0" aria-hidden>
              <span className="w-1 h-1 rounded-full animate-think-bounce" style={{ background: '#838485' }} />
              <span className="w-1 h-1 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.2s' }} />
              <span className="w-1 h-1 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.4s' }} />
            </span>
          )}
        </span>
        <span
          className={`material-symbols-outlined text-[15px] leading-none text-nova-text-muted shrink-0 transition-transform duration-300 group-hover:text-nova-text-secondary ${isExpanded ? 'rotate-180' : ''}`}
          aria-hidden
        >
          expand_more
        </span>
      </button>

      {isExpanded && (
        <div>
          <div className="px-1.5 text-[12.5px] leading-[1.65] text-nova-text-muted whitespace-pre-wrap">
            {thinking}
          </div>
          {/* 底部 hairline + 收起按钮 */}
          <div className="mt-2 border-t border-nova-border" />
          <div className="flex justify-center">
            <button
              onClick={collapse}
              className="mt-1.5 flex items-center gap-1 px-2.5 py-1 text-[11px] text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-hover rounded-md transition-colors select-none"
            >
              <span className="material-symbols-outlined text-[13px] leading-none" aria-hidden>expand_less</span>
              {t('chat.collapseProcess')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
