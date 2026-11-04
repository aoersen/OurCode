/**
 * 远端动作记录（C 档）。
 *
 * `git push` / `npm publish` / 部署这类动作写的是**远端**，本地 checkpoint
 * 救不回来——所以它们不能在"能回退"的承诺里，但也绝不能悄悄发生。主进程在
 * 执行命令前扫一次，命中就记一笔（环形日志），并把一行提示拼进命令输出，
 * 让模型和用户当场看见"这一步已经离开本机了"。
 *
 * 这里只做记录，不做拦截：公司模式的门是"能回退"，远端动作由用户/任务本身
 * 决定要不要做；记录保证事后有账可查。
 */

export type RemoteActionKind =
  | 'git-push'
  | 'publish'
  | 'deploy'
  | 'registry-push'
  | 'cluster'
  | 'remote-shell'

export interface RemoteAction {
  kind: RemoteActionKind
  label: string
}

/** 语义级白名单：只认"确定写远端"的形态，宁可漏记也不误报。 */
const RULES: Array<{ re: RegExp; kind: RemoteActionKind; label: string }> = [
  { re: /\bgit\s+push\b(?!\s+(--dry-run|-n)\b)/i, kind: 'git-push', label: 'git push（写远端仓库）' },
  { re: /\b(npm|pnpm|yarn|bun|cargo|pip|poetry|gem|composer|twine|dotnet)\s+(?:\S+\s+)*publish\b/i, kind: 'publish', label: '发布包到公共注册表' },
  { re: /\b(vercel|netlify|firebase|wrangler|flyctl|heroku|railway|surge)\b[^|;&]*\b(deploy|publish|release)\b/i, kind: 'deploy', label: '部署到远端托管' },
  { re: /\bdocker\s+push\b|\bpodman\s+push\b/i, kind: 'registry-push', label: '推送镜像到仓库' },
  { re: /\bgh\s+(release|repo)\s+(create|edit|delete)\b|\bglab\b[^|;&]*\brelease\b/i, kind: 'deploy', label: '远端仓库/发布操作' },
  { re: /\bkubectl\s+(apply|delete|replace)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b|\bterraform\s+(apply|destroy)\b/i, kind: 'cluster', label: '变更集群/基础设施' },
  { re: /\b(ssh|scp|sftp)\b|\brsync\b[^|;&]*\S+@\S+/i, kind: 'remote-shell', label: '远程主机操作（ssh/scp/rsync）' },
]

/** Detect a remote-writing action in a command string. Pure. */
export function detectRemoteAction(command: string): RemoteAction | null {
  const text = String(command || '')
  if (!text.trim()) return null
  for (const rule of RULES) {
    if (rule.re.test(text)) return { kind: rule.kind, label: rule.label }
  }
  return null
}

export interface RemoteActionRecord extends RemoteAction {
  command: string
  cwd?: string
  at: number
}

const CAP = 200
const log: RemoteActionRecord[] = []

/** Append one record (ring buffer). Never throws. */
export function recordRemoteAction(record: RemoteActionRecord): void {
  try {
    log.push(record)
    while (log.length > CAP) log.shift()
  } catch {
    /* 记录失败绝不能影响命令本身 */
  }
}

/** Read the recorded actions, optionally clearing them. */
export function listRemoteActions(opts?: { clear?: boolean }): RemoteActionRecord[] {
  const rows = log.slice()
  if (opts?.clear) log.length = 0
  return rows
}

/** The one-line note appended to a command's output. */
export function remoteActionNote(action: RemoteAction): string {
  return `[远端动作] ${action.label} —— 已记录；此操作不在本地回退范围（远端状态无法由 checkpoint 恢复）。`
}
