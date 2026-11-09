/**
 * 「编辑器与 AI」的纯函数部分 —— 语言服务行解析。
 *
 * 偏好里的 LSP 配置是 `{ 语言ID: 启动命令 }`，旧面板用「每行一条
 * `语言: 命令`」的文本域编辑，失焦即保存。这里把这段文本 ⇄ 对象的转换
 * 抽出来，避免组件里再写一遍正则/切分。
 */

/** `python: pylsp` 逐行解析；空行、缺命令的行被忽略。 */
export function parseLanguageServersText(text: string): Record<string, string> {
  const servers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const language = line.slice(0, index).trim()
    const command = line.slice(index + 1).trim()
    if (!language || !command) continue
    servers[language] = command
  }
  return servers
}

export function formatLanguageServersText(servers: Record<string, string> | undefined): string {
  return Object.entries(servers ?? {})
    .map(([language, command]) => `${language}: ${command}`)
    .join('\n')
}

export function countLanguageServers(servers: Record<string, string> | undefined): number {
  return Object.keys(servers ?? {}).length
}

/**
 * 「自动保存」在本版本没有对应偏好（旧面板也没有）：编辑器不做后台写盘。
 * 面板里给一句只读说明，而不是放一个假开关。
 */
export const AUTO_SAVE_NOTE =
  '当前版本没有自动保存开关：编辑即标记为未保存，Ctrl+S 保存；意外的未保存缓冲会写入热退出备份，重启后可恢复。'
