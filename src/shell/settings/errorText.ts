/**
 * 把 catch 到的任意错误收敛成一句可读文案。
 *
 * 旧设置面板里到处是 `error?.message || '兜底文案'`，但 IPC 层抛出来的可能是
 * 字符串、Error、或 `{ message }` 形状的对象。集中一处，避免每个 section 各写
 * 一份还不一致。
 */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    if (message) return message
  }
  if (typeof error === 'string') {
    const message = error.trim()
    if (message) return message
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}
