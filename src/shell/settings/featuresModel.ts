/**
 * 「功能」面的纯逻辑：应用名单解析、危险重置的双重确认状态机、更新状态文案。
 *
 * 这些规则原本散在旧面板的组件里（toList、两次 window.confirm、"检查中…" 三元
 * 表达式），抽出来之后既能单测，也方便新壳复用同一口径。
 */

/** 逗号 / 中文逗号 / 换行分隔 → 去重后的名单。 */
export function parseAppList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[,，\n]/)) {
    const item = part.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function formatAppList(list: ReadonlyArray<string> | undefined): string {
  return (list ?? []).join(', ')
}

/** 危险重置：未点 → 第一次确认 → 第二次确认。 */
export type ResetPhase = 'idle' | 'first' | 'second'

export type ResetEvent = 'request' | 'cancel' | 'confirmFirst' | 'confirmSecond'

/**
 * 双重确认的状态机。`confirmSecond` 表示「用户已两次确认，调用方去执行重置」，
 * 状态回到 idle（真正清空后页面会 reload）。
 */
export function reduceResetPhase(phase: ResetPhase, event: ResetEvent): ResetPhase {
  switch (event) {
    case 'request':
      return phase === 'idle' ? 'first' : phase
    case 'cancel':
      return 'idle'
    case 'confirmFirst':
      return phase === 'first' ? 'second' : phase
    case 'confirmSecond':
      return phase === 'second' ? 'idle' : phase
    default:
      return phase
  }
}

/** 更新检查的按钮/状态文案（旧面板的「检查中… / 立即检查」口径）。 */
export function updateStateLabel(state: string, newVersion: string): string {
  switch (state) {
    case 'checking':
      return '检查中…'
    case 'available':
      return newVersion ? `发现新版本 ${newVersion}` : '发现新版本'
    case 'downloading':
      return '下载中…'
    case 'downloaded':
      return '已下载，重启后安装'
    case 'error':
      return '检查失败'
    default:
      return '已是最新版本'
  }
}
