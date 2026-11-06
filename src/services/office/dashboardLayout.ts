/**
 * 「一人公司」场景里「上=看板 / 下=工作台」上下分栏的纯布局计算。
 *
 * 背景（真实缺陷）：
 * - 旧实现用「占比 15%~60%」当看板高度，且 flex-basis 是百分比：
 *   窗口一矮，40% 只剩一两百像素，三栏内容被压成几十像素、内部
 *   `overflow-y-auto` 区域高度归零 → 看起来「显示不全」且无法挽救
 *   （百分比上限 60% 也补不回工位卡需要的高度）。
 * - 分割条本身是 `h-px`（1 像素），鼠标几乎不可能命中 → 「拖不动」。
 *
 * 现在改成像素模型：高度按像素持久化，边界随可用高度实时重算，
 * 保证「看板有下限、工作台也有下限」，装不下时由容器滚动而不是压扁。
 */

/** 看板收起时只保留标题条的高度。 */
export const TAB_BAR_H = 40

/** 分割条命中区高度（视觉只有 1px 发丝线，命中区必须够大才抓得住）。 */
export const HANDLE_H = 10

/** 看板区的理想最小高度：标题条 44 + 底部汇报条 52 + 三栏内容 ≥160。 */
export const BOARD_MIN_H = 264

/** 窗口极矮时的绝对下限（再小就只剩滚动，不能再压）。 */
export const BOARD_FLOOR_H = 96

/** 工作台（4 页签）的最小高度：头部 + 内容。 */
export const WORKBENCH_MIN_H = 180

/** 首次打开（无持久化值）时的看板占比。 */
export const DEFAULT_BOARD_RATIO = 0.42

/** 装不下两边下限时，看板按可用高度的这个比例分配（其余留给工作台）。 */
const TIGHT_BOARD_SHARE = 0.55

/** 三栏并排所需的最小可用宽度；低于该宽度改为纵向堆叠。 */
export const STACK_BREAKPOINT = 620

/** 键盘微调步进（↑/↓）与粗调步进（PgUp/PgDn）。 */
export const HEIGHT_STEP = 24
export const HEIGHT_STEP_LARGE = 96

export interface BoardBounds {
  /** 允许的最小看板高度。 */
  min: number
  /** 允许的最大看板高度（扣掉工作台下限后的剩余空间）。 */
  max: number
}

/**
 * 按当前可用高度（中央列高度 − 分割条高度）算出看板高度的上下界。
 *
 * 两段式：
 * - 宽裕（可用 ≥ 看板下限 + 工作台下限）：看板 264~（可用 − 180），两边都有保底；
 * - 拮据：按 55% 分给看板、其余留给工作台，避免「看板吃满、工作台被压成 0」。
 */
export function resolveBoardBounds(available: number): BoardBounds {
  if (!Number.isFinite(available) || available <= 0) {
    return { min: BOARD_MIN_H, max: BOARD_MIN_H }
  }
  if (available >= BOARD_MIN_H + WORKBENCH_MIN_H) {
    return { min: BOARD_MIN_H, max: available - WORKBENCH_MIN_H }
  }
  // 连绝对下限都放不下：只能全给看板（工作台此时本来也不可见）
  if (available <= BOARD_FLOOR_H) return { min: available, max: available }
  const share = Math.round(available * TIGHT_BOARD_SHARE)
  const min = Math.max(BOARD_FLOOR_H, Math.min(BOARD_MIN_H, share))
  const max = Math.max(min, Math.min(available, Math.max(share, available - 60)))
  return { min, max }
}

/** 把任意高度夹到合法区间。 */
export function clampBoardHeight(value: number, available: number): number {
  const { min, max } = resolveBoardBounds(available)
  if (!Number.isFinite(value)) return min
  return Math.round(Math.min(max, Math.max(min, value)))
}

/**
 * 解析实际生效的看板高度。
 *
 * @param available 可用高度（中央列高度 − 分割条）
 * @param stored 持久化的像素高度（可能为 null / 脏值 / 来自更大的窗口）
 * @param preferredRatio 无持久化值时的初始占比
 */
export function resolveBoardHeight(
  available: number,
  stored?: number | null,
  preferredRatio: number = DEFAULT_BOARD_RATIO,
): number {
  if (!Number.isFinite(available) || available <= 0) return BOARD_MIN_H
  const ratio = Number.isFinite(preferredRatio) ? preferredRatio : DEFAULT_BOARD_RATIO
  const want =
    stored != null && Number.isFinite(stored) && stored > 0 ? stored : available * ratio
  return clampBoardHeight(want, available)
}

/** 拖拽增量：当前高度 + 位移，再夹回合法区间。 */
export function adjustBoardHeight(current: number, deltaY: number, available: number): number {
  if (!Number.isFinite(deltaY)) return clampBoardHeight(current, available)
  return clampBoardHeight(current + deltaY, available)
}

/** 三栏并排还是纵向堆叠（栏宽被压到几十像素时，三栏文字全成「需…」）。 */
export function shouldStackDashboard(width: number): boolean {
  return width > 0 && width < STACK_BREAKPOINT
}
