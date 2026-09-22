/**
 * Static dangerous-command analysis for run_command.
 *
 * The approval pipeline can be exempted wholesale (plan-mode auto-approve,
 * full_access edit mode, batch approval, per-project allowlist) — when every
 * other gate is off, this check is the last line of defense. It is deliberately
 * conservative: a "dangerous" verdict never blocks the command, it only forces
 * the approval dialog (even under exemptions) and annotates the preview, so a
 * false positive costs one extra click, never a broken workflow.
 *
 * Pure and side-effect free: the verdict depends only on the command string.
 */
export interface DangerFinding {
  reason: string
}

/** Root-ish targets for destructive rm — an accidental `rm -rf /` (or `C:\`)
 *  is unrecoverable, while `rm -rf ./dist` inside the workspace is fine.
 *  Anchored: only the exact dangerous spellings match, so an absolute path
 *  like /home/user/proj/build does NOT trip the rule. */
const ROOTISH_RM_TARGET =
  /^(\/|\/\*|~|~\/|\*|\$HOME|\$env:HOME|%USERPROFILE%|C:\\|C:\/|D:\\|D:\/|\.|\.\/)$/i

// The checks are functions: several rules need the matched target/flag to
// phrase a useful reason, which a uniform regex list can't express.
const CHECKS: Array<(command: string) => DangerFinding | null> = [
  (c) => {
    const m = /\brm\s+((?:-[a-z]+\s+)+)(?:--no-preserve-root\s+)?([^\s|;&]+)\s*$/i.exec(c)
    if (!m) return null
    const flags = m[1].toLowerCase()
    const hasRecursive = flags.includes('r')
    const hasForce = flags.includes('f')
    if (!hasRecursive || !hasForce) return null
    if (!ROOTISH_RM_TARGET.test(m[2])) return null
    return { reason: `递归强制删除根目录/家目录级路径：${m[2].trim()}` }
  },
  (c) => {
    // PowerShell 等价物：Remove-Item -Recurse -Force <rootish>
    const m = /\bRemove-Item\s+[^|;&]*(-Recurse|-r)\s+[^|;&]*(-Force|-f)\s+([^\s|;&]+)\s*$/i.exec(c)
    if (!m) return null
    if (!ROOTISH_RM_TARGET.test(m[3])) return null
    return { reason: `递归强制删除根目录/家目录级路径：${m[3].trim()}` }
  },
  // Command position = string start / newline / separator, plus canonical
  // command prefixes (sudo, cmd /c, sh -c). The keyword must sit right after
  // them — 'npm run format' or '--format=' never match. The prefixes sit
  // OUTSIDE the anchor alternation so they apply after '^' as well as after
  // separators.
  (c) => /(?:^|[\n;&|])\s*(?:(?:sudo|doas)\s+)?(?:cmd\s+\/c\s+)?(?:(?:ba|z)?sh\s+-c\s+)?(?:format|diskpart|shutdown|reboot)\b(?!-)/i.test(c)
    ? { reason: '磁盘格式化 / 关机重启类系统命令' }
    : null,
  (c) => /\bRestart-Computer\b|\bStop-Computer\b/i.test(c)
    ? { reason: '关机重启类系统命令' }
    : null,
  (c) => /\|\s*(ba)?sh\b/i.test(c) || /\bInvoke-Expression\b/i.test(c) || /\biex\s*\(/i.test(c)
    ? { reason: '管道执行远程内容 / 动态表达式执行（远程代码执行形态）' }
    : null,
  (c) => /\bpowershell\b[^|;&]*-(enc(odedcommand)?|e)\b/i.test(c)
    ? { reason: 'Base64 编码的 PowerShell 命令（混淆执行形态）' }
    : null,
  (c) => /\bgit\s+push\b[^|;&]*--force/.test(c)
    ? { reason: 'git push --force（覆盖远端历史，不可逆）' }
    : null,
  (c) => /\bgit\s+reset\s+--hard\b/.test(c)
    ? { reason: 'git reset --hard（丢弃未提交改动）' }
    : null,
  (c) => /\bgit\s+clean\s+(-[a-z]*f[a-z]*)\b/i.test(c)
    ? { reason: 'git clean -f（删除未跟踪文件）' }
    : null,
  (c) => /\b(npm|yarn|pnpm|bun|cargo)\s+publish\b/.test(c)
    ? { reason: '向公共注册表发布包（对外发布，不可撤销）' }
    : null,
  (c) => /\bdocker\s+push\b/.test(c)
    ? { reason: '推送镜像到远端仓库（对外发布）' }
    : null,
  (c) => /\bchmod\s+(-R|-r)\s+777\s+(\/|~|\$HOME)/i.test(c)
    ? { reason: '对根/家目录递归开放全部权限' }
    : null,
  (c) => /\bdel\s+(\/[sq]+\s+)+\s*C:\\/i.test(c)
    ? { reason: '递归删除盘根（del /s /q）' }
    : null,
]

/**
 * Analyze a shell command for destructive / irreversible / remote-execution
 * shapes. Returns the first matching rule's reason, or null when the command
 * looks routine.
 */
export function analyzeDangerousCommand(command: string): DangerFinding | null {
  const text = (command || '').trim()
  if (!text) return null
  for (const check of CHECKS) {
    const finding = check(text)
    if (finding) return finding
  }
  return null
}
