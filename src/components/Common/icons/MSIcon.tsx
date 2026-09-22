import { MATERIAL_PATHS } from './materialPaths'

/**
 * Material Symbols 图标的本地 SVG 版。
 *
 * 原先的写法是带 material-symbols-outlined 类的 span + 图标名文本，靠 Google Fonts
 * 的连字字体把名字替换成图形。那条路有两个问题：字体只从外网加载（局域网/离线部署
 * 时图标全部退化成 "smart_toy" 这样的字面文本），而且 3.9MB 的字体只为几十个图标。
 * （想只打包用到的字形也不行：Material Symbols 的连字挂在 rclt/rlig 必需特性上，
 * 子集化一保留这些特性就会把 6618 个字形全拖回来，仍是 3.9MB。）
 * 这里改成打包进产物的 path 数据。
 *
 * 尺寸沿用 1em，所以原来写在该元素上的 text-[14px] / shrink-0 / 颜色类照常生效。
 */
export default function MSIcon({ name, className }: { name: string; className?: string }) {
  const d = MATERIAL_PATHS[name]
  if (!d) return null
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden
      focusable="false"
      data-icon={name}
      className={className}
    >
      <path d={d} />
    </svg>
  )
}
