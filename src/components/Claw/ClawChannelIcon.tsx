import type { ClawChannelId } from '@shared/types'

/**
 * 渠道图标：品牌色圆角方块 + 线性图标。
 *
 * 这里是**通用图标语义**（对话气泡 / 企业楼宇 / 消息圆点 / 层叠卡片 / 纸飞机），
 * 不用各平台商标图形。
 *
 * 颜色处理：品牌色直接当描边时，浅色品牌（微信 #07c160 = 2.38:1、QQ #12b7f5 =
 * 2.30:1，白底）达不到图形元素 3:1 的对比要求。因此描边/图标与底色都从品牌色
 * 向正文色混合 35%（实测最浅配色 4.50:1，最深 7.20:1），既保留渠道辨识度又满足
 * 对比度；底色只做 14% 淡染，不承载信息。
 */
const GLYPHS: Record<ClawChannelId, JSX.Element> = {
  wechat: (
    <>
      <path d="M4 10.5a5.5 5.5 0 0 1 5.5-5.5h.5" />
      <path d="M20 13a6 6 0 0 1-6 6H9l-5 3 1.2-3.6A6 6 0 0 1 8 7.2" />
      <path d="M9.5 11h.01M14.5 11h.01" />
    </>
  ),
  wecom: (
    <>
      <path d="M4 21V7l6-3v17" />
      <path d="M10 21V9l6 2v10" />
      <path d="M16 21v-8l4 1v7" />
      <path d="M7 11h.01M7 15h.01M13 13h.01M13 17h.01" />
    </>
  ),
  qq: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 10h.01M15 10h.01" />
      <path d="M9 15c1 .8 5 .8 6 0" />
      <path d="M15.5 17.5c1.2.4 2 1 2 1.6 0 .5-1.5.9-3.5.9" />
    </>
  ),
  feishu: (
    <>
      <path d="M4 9.5 12 5l8 4.5-8 4.5z" />
      <path d="M4 14.5 12 19l8-4.5" />
    </>
  ),
  telegram: (
    <>
      <path d="M21 4 3 11l5 2 2 6 3-4" />
      <path d="M21 4l-7 15-3-4" />
    </>
  ),
}

export default function ClawChannelIcon({
  id,
  color,
  size = 28,
  radius = 9,
}: {
  id: ClawChannelId
  color: string
  size?: number
  radius?: number
}) {
  const ink = `color-mix(in srgb, ${color} 65%, var(--text-primary) 35%)`
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${ink} 22%, transparent)`,
        color: ink,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.62}
        height={size * 0.62}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLYPHS[id]}
      </svg>
    </span>
  )
}
