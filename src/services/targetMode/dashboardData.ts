/**
 * 「一人公司」看板数据读取层。
 *
 * 从 .ourcode/targemode/ 目录读取经营日志与交付物清单，
 * 供 CompanyDashboard 组件消费。不引入 chatStore，
 * 遵循 budget.ts 的单向依赖原则。
 */

/** 经营日志条目（从 supervisor.md 解析）。 */
export interface LogEntry {
  time: string
  text: string
}

/** 交付物条目（agents/ 目录下的 .md 文件）。 */
export interface Deliverable {
  name: string
  path: string
  /** 最后修改时间（ms）；listDir 未提供时为 undefined */
  modifiedAt?: number
}

const TARGET_MODE_DIR = '.ourcode/targemode'

function join(root: string, ...rel: string[]): string {
  return [root.replace(/[\\/]+$/, ''), TARGET_MODE_DIR, ...rel].join('/')
}

/**
 * 读取 agents/supervisor.md，按行解析为日志条目。
 * 格式：`[HH:MM:SS] 内容` 或 `[时间] 内容`，返回倒序（最新在前），限 50 条。
 */
export async function readSupervisorLog(root: string): Promise<LogEntry[]> {
  if (!root) return []
  try {
    const { content } = await window.electronAPI.readFile(join(root, 'agents', 'supervisor.md'))
    if (!content) return []
    const entries: LogEntry[] = []
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\[([^\]]+)\]\s*(.+)/)
      if (m) entries.push({ time: m[1], text: m[2].trim() })
    }
    return entries.reverse().slice(0, 50)
  } catch {
    return []
  }
}

/**
 * 列出 agents/ 目录下的 .md 文件（交付物），排除 README.md。
 * 按最后修改时间倒序（最新交付物在前），无时间戳时退化为按名称。
 */
export async function listDeliverables(root: string): Promise<Deliverable[]> {
  if (!root) return []
  try {
    const entries = await window.electronAPI.listDir(join(root, 'agents'))
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith('.md') && e.name !== 'README.md')
      .map((e) => ({ name: e.name, path: e.path, modifiedAt: e.modifiedAt }))
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || a.name.localeCompare(b.name))
  } catch {
    return []
  }
}
