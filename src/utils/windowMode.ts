/**
 * 窗口模式（window mode）。
 *
 * 应用现在有两种窗口：
 * - 对话窗口（main，默认）：常规 IDE + 右侧对话面板。
 * - 一人公司窗口（office）：3D 办公室视图落地、独立会话/项目命名空间的独立窗口。
 *
 * 主进程通过 webPreferences.additionalArguments 注入 '--office-mode'，
 * preload 同步暴露为 electronAPI.isOfficeMode（见 preload.ts）。
 * 这里是渲染进程引用该标志的唯一入口 —— 各 store / 组件应 import 这个常量，
 * 而不是到处读 window.electronAPI。
 */
export const IS_OFFICE = typeof window !== 'undefined' && !!window.electronAPI?.isOfficeMode

/** 本窗口的会话模式（SQLite chat_sessions.mode / getSessions 过滤用）。 */
export const WINDOW_MODE: 'main' | 'office' = IS_OFFICE ? 'office' : 'main'

/**
 * 按窗口模式取一个 localStorage key：办公室窗口使用独立命名空间，实现
 * 「一人公司 项目/工作区 与 对话模式互不干扰」。全局偏好（主题、语言、快捷键、
 * 模型缓存等）仍走共享 key —— 那些是"特点情况"下应当一致的应用级设置。
 */
export function modeKey(base: string): string {
  return IS_OFFICE ? `${base}_office` : base
}
