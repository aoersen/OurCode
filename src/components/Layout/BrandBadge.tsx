import { IS_OFFICE } from '@/utils/windowMode'
import { brandIdentity } from './brand'

interface BrandBadgeProps {
  /**
   * 是否一人公司窗口。默认取本窗口模式（utils/windowMode），
   * 只有预览/测试才显式传入，保证运行时仍只有一个模式来源。
   */
  isOffice?: boolean
}

/**
 * 左上角品牌标识。
 *
 * 两个窗口模式是两套身份（映射表见 ./brand.ts）：
 * - 普通对话窗口：圆形光点 + 纯产品名 OurCode —— 「IDE + 对话」。
 * - 一人公司窗口：渐变方章（楼宇）+ 一人公司 —— 「一家公司在运转」。
 * 形状与文字同时变化，不依赖颜色单通道区分。
 */
export default function BrandBadge({ isOffice = IS_OFFICE }: BrandBadgeProps = {}) {
  const brand = brandIdentity(isOffice)
  const showMode = brand.mode === 'office'

  return (
    <div
      className="flex items-center pl-3 pr-2 gap-2 no-drag"
      data-brand-mode={brand.mode}
      role="img"
      aria-label={brand.fullName}
      title={brand.fullName}
    >
      {showMode ? (
        <span
          aria-hidden="true"
          className="grid place-items-center w-5 h-5 rounded-md shrink-0"
          style={{
            backgroundImage:
              'linear-gradient(135deg, var(--accent, #0058bc) 0%, var(--accent-purple, #7c3aed) 100%)',
            boxShadow: '0 1px 6px color-mix(in srgb, var(--accent-purple, #7c3aed) 35%, transparent)',
            // 方章墨色随主题翻转（深色主题的底是浅色渐变），见 global.css。
            color: 'var(--brand-seal-ink, #ffffff)',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 21V8l6-4 6 4v13" />
            <path d="M16 21V5l4 3v13" />
            <path d="M2 21h20" />
          </svg>
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="w-3.5 h-3.5 rounded-full animate-logo-pulse shrink-0"
          style={{
            backgroundImage:
              'linear-gradient(135deg, var(--accent, #0058bc) 0%, var(--accent-purple, #7c3aed) 100%)',
            boxShadow: '0 0 8px color-mix(in srgb, var(--accent, #0058bc) 45%, transparent)',
          }}
        />
      )}

      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span
          className={
            showMode
              ? 'text-[10px] font-semibold uppercase tracking-[0.12em] text-nova-text-muted'
              : 'text-xs font-bold text-nova-text-primary tracking-tight'
          }
        >
          {brand.product}
        </span>
        {brand.modeName && (
          <span
            className="text-xs font-extrabold tracking-tight"
            style={{
              backgroundImage:
                'linear-gradient(90deg, var(--accent, #0058bc) 0%, var(--accent-purple, #7c3aed) 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {brand.modeName}
          </span>
        )}
      </span>
    </div>
  )
}
