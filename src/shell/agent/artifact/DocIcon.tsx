import type { FileTone } from './docModel'

/**
 * 文件类型图标（12–14px，线性描边，单色）。
 *
 * 为什么是图标而不是「TS / PNG」文字：文件名本身已经带扩展名，再在前面加
 * 三个大写字母既重复又把标签撑宽（「PNG 取通知书2.png」）。图标只表达类别
 * （代码 / 文档 / 图片 / 数据 / 样式 / 标记 / 二进制），类型全名留在 tooltip
 * 与编辑器状态栏里。
 */
export default function DocIcon({
  tone,
  className = 'w-3.5 h-3.5',
}: {
  tone: FileTone
  className?: string
}) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {tone === 'code' && (
        <>
          <path d="M6 4.5L2.5 8 6 11.5" />
          <path d="M10 4.5L13.5 8 10 11.5" />
        </>
      )}
      {tone === 'markup' && (
        <>
          <path d="M5 4.5L1.8 8 5 11.5" />
          <path d="M11 4.5L14.2 8 11 11.5" />
          <path d="M9.2 3.2L6.8 12.8" />
        </>
      )}
      {tone === 'style' && (
        <>
          <path d="M6.2 3v10M9.8 3v10" />
          <path d="M3 6.2h10M3 9.8h10" />
        </>
      )}
      {tone === 'data' && (
        <>
          <path d="M6 2.8c-1.6 0-1.9 1-1.9 2.4v1.6c0 1-.5 1.4-1.4 1.4.9 0 1.4.4 1.4 1.4v1.6c0 1.4.3 2.4 1.9 2.4" />
          <path d="M10 2.8c1.6 0 1.9 1 1.9 2.4v1.6c0 1 .5 1.4 1.4 1.4-.9 0-1.4.4-1.4 1.4v1.6c0 1.4-.3 2.4-1.9 2.4" />
        </>
      )}
      {tone === 'doc' && (
        <>
          <path d="M3.6 2.6h5.2L12 5.8v7.6H3.6z" />
          <path d="M8.6 2.6v3.2H12" />
          <path d="M5.6 8.4h4.6M5.6 10.8h3.2" />
        </>
      )}
      {tone === 'image' && (
        <>
          <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6" />
          <circle cx="5.8" cy="6.6" r="1" />
          <path d="M2.8 11.2l3.1-3 2.2 2.1 2-2 3.1 3" />
        </>
      )}
      {tone === 'binary' && (
        <>
          <rect x="2.6" y="3" width="10.8" height="10" rx="1.4" />
          <path d="M8 3v10M2.6 8h10.8" />
        </>
      )}
      {(tone === 'other' || !tone) && (
        <>
          <path d="M3.6 2.6h5.2L12 5.8v7.6H3.6z" />
          <path d="M8.6 2.6v3.2H12" />
        </>
      )}
    </svg>
  )
}
