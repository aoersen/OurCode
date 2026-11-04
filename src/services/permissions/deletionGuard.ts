/**
 * Narrow deletion guard — "能放过就不拦".
 *
 * 公司模式没有人工审批，删除是唯一需要提前判断的动作，但判断必须窄：只有
 * **删完机器就坏 / 任何快照都救不回来**的目标才拒绝，其余一律放行。
 *
 * 硬拒绝集合（平台级灾难）：
 *   - 盘根 / 文件系统根
 *   - 系统目录（C:\Windows、Program Files、/etc、/usr …，按前缀匹配，不按任意段）
 *   - 用户主目录根、AppData 根
 *   - 当前工作区根 / 工作区根的任何上级目录
 *   - .git 目录（嵌套仓库也算；影子快照永远不包含 .git）
 *   - 命令形态的递归删除：工作区外、不可重建、非临时目录的目标
 *
 * 其余全部放行：项目内的 `bin/etc/system` 只是普通目录名，不构成系统目录；
 * 生成目录（build/dist/node_modules…）和临时目录即使在工作区外也允许删除。
 * 误报会教会模型改用 shell 绕过预检，反而更危险，所以这里宁可漏也不误拦。
 *
 * 纯函数、无 Electron 依赖，便于单测。
 */

export function normPath(p: string): string {
  const s = String(p || '').replace(/\\/g, '/')
  const trimmed = s.replace(/\/+$/, '')
  // "/" must stay "/" (a trailing-slash trim would erase the filesystem root).
  return trimmed || (s.startsWith('/') ? '/' : '')
}

/** Resolve `p` against `projectRoot` and collapse `.`/`..` segments. */
export function resolveAgainst(projectRoot: string, p: string): string {
  const raw = String(p || '').trim()
  if (!raw) return projectRoot
  const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')
  const base = absolute ? '' : normPath(projectRoot)
  const joined = absolute ? raw.replace(/\\/g, '/') : `${base}/${raw.replace(/\\/g, '/')}`
  const drive = /^[a-zA-Z]:/.exec(joined)?.[0] ?? ''
  const rest = drive ? joined.slice(drive.length) : joined
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      else return `${drive}/..` // escaped above the root
      continue
    }
    parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

export function isInsideProject(projectRoot: string, absPath: string): boolean {
  const root = normPath(resolveAgainst(projectRoot, '.')).toLowerCase()
  const p = normPath(absPath).toLowerCase()
  if (!root) return false
  if (root === '/') return p.startsWith('/')
  return p === root || p.startsWith(root + '/')
}

/** 生成物与依赖缓存：删了要重建，但不影响"代码能不能回退"。 */
export const REBUILDABLE_SEGMENTS = new Set([
  'build', 'dist', 'out', 'target', 'coverage', 'node_modules', 'bower_components',
  '.gradle', '.dart_tool', '.pub-cache', '.venv', '__pycache__', '.pytest_cache',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', '.idea',
])

/** 客户机器上的"人"的目录：删除结论里要标出来，但不单独构成硬拒绝。 */
export const USER_DATA_SEGMENTS = new Set([
  'documents', 'desktop', 'pictures', 'downloads', 'music', 'videos', 'onedrive',
  '桌面', '文档', '图片', '下载', '音乐', '视频', '收藏夹',
])

/** 系统根按前缀匹配，避免把项目里的 `src/bin`、`config/etc` 误判成系统目录。 */
const SYSTEM_PREFIXES = [
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/system',
  '/library',
  '/dev',
  '/proc',
  '/sys',
]

const HOME_TOKENS = /^(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)$/i
const APPDATA_TOKENS = /^(%appdata%|%localappdata%|\$env:appdata|\$env:localappdata)$/i

export function segmentsOf(p: string): string[] {
  return normPath(p)
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

export function isDriveRoot(p: string): boolean {
  const s = normPath(p).toLowerCase()
  return /^[a-z]:$/.test(s) || s === '/'
}

export function isSystemRoot(p: string): boolean {
  const s = normPath(p).toLowerCase()
  if (!s) return false
  if (isDriveRoot(s)) return true
  return SYSTEM_PREFIXES.some((prefix) => s === prefix || s.startsWith(prefix + '/'))
}

export function isHomeRoot(p: string): boolean {
  const raw = String(p || '').trim().toLowerCase()
  if (HOME_TOKENS.test(raw)) return true
  const s = normPath(raw)
  if (s === 'c:/users' || s === '/home' || s === '/users' || s === '/root') return true
  return /^c:\/users\/[^/]+$/.test(s) || /^\/home\/[^/]+$/.test(s) || /^\/users\/[^/]+$/.test(s)
}

export function isAppDataRoot(p: string): boolean {
  const raw = String(p || '').trim().toLowerCase()
  if (APPDATA_TOKENS.test(raw)) return true
  const s = normPath(raw)
  return (
    /^c:\/users\/[^/]+\/appdata$/.test(s) ||
    /^c:\/users\/[^/]+\/appdata\/(roaming|local|locallow)$/.test(s)
  )
}

export function isTempPath(p: string): boolean {
  const raw = String(p || '').trim().toLowerCase()
  if (raw === '%temp%' || raw === '$env:temp' || raw.startsWith('%temp%/') || raw.startsWith('$env:temp/')) return true
  const s = normPath(raw)
  if (!s) return false
  return (
    s === '/tmp' || s.startsWith('/tmp/') ||
    s === '/var/tmp' || s.startsWith('/var/tmp/') ||
    s === '/private/tmp' || s.startsWith('/private/tmp/') ||
    /^c:\/users\/[^/]+\/appdata\/local\/temp(\/|$)/.test(s)
  )
}

export function isRebuildablePath(p: string): boolean {
  return segmentsOf(p).some((seg) => REBUILDABLE_SEGMENTS.has(seg))
}

export function looksLikeUserDataPath(p: string): boolean {
  return segmentsOf(p).some((seg) => USER_DATA_SEGMENTS.has(seg))
}

/**
 * Hard-block reason for a single delete target, or null when it should pass.
 * `target` may be absolute or relative to `projectRoot`.
 */
export function protectedDeleteReason(target: string, projectRoot: string): string | null {
  const raw = String(target || '').trim()
  if (!raw) return null
  const rawLower = raw.toLowerCase()
  if (HOME_TOKENS.test(rawLower)) {
    return `拒绝删除用户主目录：${raw}。请删除具体子目录，或先确认这是任务所需。`
  }
  if (APPDATA_TOKENS.test(rawLower)) {
    return `拒绝删除应用数据根目录：${raw}。请删除具体子目录。`
  }

  const project = projectRoot ? normPath(resolveAgainst(projectRoot, '.')).toLowerCase() : ''
  const abs = normPath(resolveAgainst(projectRoot || '', raw))
  const p = abs.toLowerCase()
  if (!p) return null

  if (p === '/..' || /\/\.\.$/.test(p)) {
    return `拒绝删除越界路径：${raw}（解析后越过根目录）。`
  }
  if (isDriveRoot(p)) {
    return `拒绝删除盘根：${raw}。它不在任何快照范围内，会直接损坏机器。`
  }
  if (isSystemRoot(p)) {
    return `拒绝删除系统目录：${raw}。它不在任何快照范围内，会直接损坏机器。`
  }
  if (isHomeRoot(p)) {
    return `拒绝删除用户主目录：${raw}。请删除具体子目录，或先确认这是任务所需。`
  }
  if (isAppDataRoot(p)) {
    return `拒绝删除应用数据根目录：${raw}。请删除具体子目录。`
  }
  if (project && p === project) {
    return `拒绝删除整个工作区：${raw}。请删除项目内的具体子路径。`
  }
  if (project && project.startsWith(p + '/')) {
    return `拒绝删除工作区的上级目录：${raw}。`
  }
  const base = p.split('/').filter(Boolean).pop()
  if (base === '.git') {
    return `拒绝删除 .git 目录：${raw}。项目/嵌套仓库的版本历史不在快照范围内，删了无法恢复。`
  }
  return null
}

// ── Destructive command parsing (rm / Remove-Item / del / rd / git clean) ──

export interface DestructiveScan {
  targets: string[]
  recursive: boolean
  blockReason?: string
}

function stripOuterQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function tokenize(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Split on shell separators, respecting quotes. `{`/`(` also start a command. */
function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|') || ch === '|') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      if (ch === '&' || ch === '|') i++
      continue
    }
    if (ch === '{' || ch === '(') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

interface TargetScan {
  targets: string[]
  recursive: boolean
}

function scanSegment(segment: string, depth = 0): TargetScan {
  if (depth > 3) return { targets: [], recursive: false }
  let seg = segment.trim()
  // Strip shell keyword / elevation prefixes.
  seg = seg.replace(/^(?:then|do|else|elif)\s+/i, '')
  seg = seg.replace(/^(?:sudo|doas)\s+/i, '')
  seg = stripOuterQuotes(seg)

  // Nested shells: bash -c "...", cmd /c "...", powershell -Command "..."
  const nested =
    /^(?:ba|z|k)?sh\s+-c\s+([\s\S]+)$/i.exec(seg) ||
    /^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i.exec(seg) ||
    /^(?:powershell|pwsh)(?:\.exe)?(?:\s+-[^\s]+)*\s+(?:-command|-c)\s+([\s\S]+)$/i.exec(seg)
  if (nested) {
    const inner = stripOuterQuotes(nested[1])
    const children = splitSegments(inner)
    for (const child of children) {
      const scan = scanSegment(child, depth + 1)
      if (scan.recursive) return scan
    }
    return { targets: [], recursive: false }
  }

  // rm [-rf] target...
  const rmMatch = /^(?:rm|rm\.exe)\s+([\s\S]+)$/i.exec(seg)
  if (rmMatch) {
    const tokens = tokenize(rmMatch[1])
    const recursive = tokens.some(
      (t) => /^--recursive$/i.test(t) || (/^-[^-]/.test(t) && /[rR]/.test(t)),
    )
    const targets = tokens.filter((t) => t !== '--' && !t.startsWith('-'))
    return { targets, recursive }
  }

  // PowerShell Remove-Item / ri
  const riMatch = /^(?:remove-item|ri)\s+([\s\S]+)$/i.exec(seg)
  if (riMatch) {
    const tokens = tokenize(riMatch[1])
    const recursive = tokens.some((t) => /^-(?:recurse|r)$/i.test(t))
    const targets: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (/^-(?:path|literalpath)$/i.test(t)) {
        if (tokens[i + 1]) targets.push(tokens[++i])
        continue
      }
      if (t.startsWith('-')) continue
      targets.push(t)
    }
    return { targets, recursive }
  }

  // del / erase /s /q target
  const delMatch = /^(?:del|erase)\s+([\s\S]+)$/i.exec(seg)
  if (delMatch) {
    const tokens = tokenize(delMatch[1])
    const recursive = tokens.some((t) => /^\/s/i.test(t))
    return { targets: tokens.filter((t) => !/^[/-]/.test(t)), recursive }
  }

  // rd / rmdir /s /q target
  const rdMatch = /^(?:rd|rmdir)\s+([\s\S]+)$/i.exec(seg)
  if (rdMatch) {
    const tokens = tokenize(rdMatch[1])
    const recursive = tokens.some((t) => /^\/s/i.test(t))
    return { targets: tokens.filter((t) => !/^[/-]/.test(t)), recursive }
  }

  return { targets: [], recursive: false }
}

/** Home/AppData-relative targets are outside the workspace by definition. */
function isSymbolicOutside(p: string): boolean {
  return /^(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|%appdata%|%localappdata%|\$env:appdata|\$env:localappdata)(\/|$)/i.test(
    String(p || '').trim(),
  )
}

function resolveCommandTarget(raw: string, cwd: string, projectRoot: string): { abs: string; judgeable: boolean } {
  const t = stripOuterQuotes(raw).trim()
  if (!t) return { abs: '', judgeable: false }
  // Home / AppData tokens: keep them symbolic — protectedDeleteReason knows them.
  const homeRelative = /^(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)(\/.*)?$/i.exec(t)
  if (homeRelative) return { abs: `${homeRelative[1]}${homeRelative[2] || ''}`, judgeable: true }
  const appRelative = /^(%appdata%|%localappdata%|\$env:appdata|\$env:localappdata)(\/.*)?$/i.exec(t)
  if (appRelative) return { abs: `${appRelative[1]}${appRelative[2] || ''}`, judgeable: true }
  // Shell globs covering the directory itself.
  if (t === '*' || t === './*' || t === '*.*') {
    return { abs: resolveAgainst(projectRoot || cwd, '.'), judgeable: true }
  }
  // Unresolvable variable expansion: don't guess, don't block.
  if (/^[$%]/.test(t)) return { abs: t, judgeable: false }
  return { abs: resolveAgainst(cwd || projectRoot, t), judgeable: true }
}

/**
 * Scan a shell command for destructive recursive deletes. Returns the first
 * hard-block reason, or null when the command is allowed to proceed.
 */
export function analyzeDestructiveCommand(
  command: string,
  opts: { cwd?: string; projectRoot?: string },
): DestructiveScan {
  const text = String(command || '')
  const projectRoot = String(opts.projectRoot || '')
  const cwd = String(opts.cwd || projectRoot)
  const targets: string[] = []
  let recursive = false
  let outsideReason: string | undefined

  for (const segment of splitSegments(text)) {
    // Machine-level actions that are not file deletes but are equally
    // unrecoverable in an unattended run.
    if (
      /^(?:sudo\s+|doas\s+)?(?:shutdown|reboot|halt|poweroff)\b/i.test(segment) ||
      /\b(?:Restart-Computer|Stop-Computer)\b/i.test(segment) ||
      /^(?:sudo\s+|doas\s+)?(?:format|diskpart)\b/i.test(segment)
    ) {
      return {
        targets,
        recursive,
        blockReason: `拒绝机器级不可逆动作：${segment.slice(0, 80)}。它不在任何快照范围内。`,
      }
    }

    // `git clean` removes cwd's contents, not cwd itself. It is a normal
    // project-root cleanup — only block when cwd itself is outside the
    // workspace and not rebuildable/temp (another project / a system dir).
    if (/^git\s+clean\b/i.test(segment) && /\s-[a-z]*f/i.test(segment)) {
      recursive = true
      if (
        projectRoot &&
        !isInsideProject(projectRoot, cwd) &&
        !isRebuildablePath(cwd) &&
        !isTempPath(cwd)
      ) {
        if (!outsideReason) {
          outsideReason =
            `拒绝在工作区外执行 git clean：${cwd}。它的删除范围不在任何快照内，无法恢复。`
        }
      }
      continue
    }

    const scan = scanSegment(segment)
    if (!scan.recursive || scan.targets.length === 0) continue
    recursive = true
    for (const raw of scan.targets) {
      const { abs, judgeable } = resolveCommandTarget(raw, cwd, projectRoot)
      if (!abs || !judgeable) continue
      targets.push(abs)
      const fatal = protectedDeleteReason(abs, projectRoot)
      if (fatal) return { targets, recursive, blockReason: fatal }
      if (
        projectRoot &&
        (isSymbolicOutside(abs) || !isInsideProject(projectRoot, abs)) &&
        !isRebuildablePath(abs) &&
        !isTempPath(abs)
      ) {
        if (!outsideReason) {
          outsideReason =
            `拒绝递归删除工作区外的目录：${abs}。它不在任何快照范围内，删除后无法恢复；` +
            `生成目录（build/dist/node_modules 等）或临时目录会被放行。`
        }
      }
    }
  }

  return { targets, recursive, blockReason: outsideReason }
}
