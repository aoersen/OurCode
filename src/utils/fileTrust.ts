/**
 * Read a file through the fs allowlist, asking the user for one-time read
 * permission when the path lies outside the trusted workspace.
 *
 * Out-of-workspace chat attachments (e.g. a document dragged in from a WeChat
 * folder) are rejected by fs:readFile with a marked error until the user
 * approves them once via a native dialog (`trust:requestFile` in the main
 * process). Every other fs read path keeps treating reads as fire-and-forget —
 * only the chat tool/context reads go through `readFileWithTrust`.
 */

/** Prefix the main process stamps onto allowlist rejections. */
export const UNTRUSTED_PATH_MARKER = 'EUNTRUSTED'

export function isUntrustedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  // The marker is the contract; the Chinese text is a fallback for errors from
  // older builds (the marker was added after the original message).
  return msg.includes(UNTRUSTED_PATH_MARKER) || msg.includes('路径不在允许范围内')
}

/**
 * Read a file, prompting once for read permission when the path is outside
 * the trusted workspace. Returns the raw content, or rethrows the original
 * error when permission is refused (or the trust request itself fails).
 *
 * `mode` is the session's project edit mode (手动确认 / 自动编辑 / 计划模式 /
 * 完全访问). It only shapes which native dialog the main process shows —
 * per-file buttons, or with a session-wide "全部允许" option; the native
 * answer is the only thing that can grant anything.
 */
export async function readFileWithTrust(path: string, mode?: string): Promise<string> {
  try {
    const { content } = await window.electronAPI.readFile(path)
    return content
  } catch (e) {
    if (!isUntrustedError(e)) throw e
    let granted = false
    try {
      granted = await window.electronAPI.requestFileTrust(path, mode)
    } catch {
      granted = false
    }
    if (!granted) throw e
    const { content } = await window.electronAPI.readFile(path)
    return content
  }
}
