/**
 * 左上角品牌标识 × 窗口模式。
 *
 * 应用有两种窗口模式（见 utils/windowMode.ts），它们是**两套身份**，
 * 左上角标识必须一眼可分 —— 否则用户分不清自己当前在哪一边下指令：
 *
 * - 普通对话窗口（main）：圆点 + 纯产品名「OurCode」。这里是「写代码 + 和 AI 对话」。
 * - 一人公司窗口（office）：渐变方章（楼宇）+「一人公司」。这里是「一家公司在运转」。
 *
 * 判定只接受一个布尔（IS_OFFICE）而不是在组件里各自去读 electronAPI，
 * 这样标识逻辑可以单测，也保证全应用只有一个模式来源。
 */

export type BrandMode = 'main' | 'office'

export interface BrandIdentity {
  /** 与 utils/windowMode 的 WINDOW_MODE 对齐。 */
  mode: BrandMode
  /** 产品名，两种模式共享。 */
  product: string
  /** 模式名。普通对话窗口为空串（只显示产品名），一人公司窗口为「一人公司」。 */
  modeName: string
  /** 无障碍标签 / hover 提示用的完整名称。 */
  fullName: string
  /** 标记形状：普通对话窗口是圆点，一人公司窗口是方章。 */
  mark: 'dot' | 'seal'
}

export function brandIdentity(isOffice: boolean): BrandIdentity {
  if (isOffice) {
    return {
      mode: 'office',
      product: 'OurCode',
      modeName: '一人公司',
      fullName: 'OurCode 一人公司',
      mark: 'seal',
    }
  }
  return {
    mode: 'main',
    product: 'OurCode',
    modeName: '',
    fullName: 'OurCode',
    mark: 'dot',
  }
}
