/**
 * 一人公司 MCP 分配（v1.2）：按角色分配可用的 MCP 服务器，未分配的角色吃默认档。
 *
 * 存储：项目根 `.ourcode/company.json` —— 公司看板的「MCP 分配」面板写它，
 * 用户手改文件同样生效；该文件是唯一事实源。角色定义 .md 的 frontmatter
 * `mcp:` / `mcpDeny:` 是次要入口，与 company.json 取并集（只增不减）。
 *
 * 解析规则：有效授权(role) = roles[role] ?? default ?? 'all'。
 * 'all' 含未来新装的服务器——装新 MCP 对未分配角色零操作。
 * 点名清单（自选）有静默失败模式（服务器改名/删除后授予落空），所以
 * reconcileMcpGrantServers 负责在员工运行启动时对账，缺失项由调用方提示。
 */
import type { McpGrantSpec } from '@/services/subagents/subagentDefinitions'

/** 项目内相对路径（UI 保存与测试共用）。 */
export const COMPANY_CONFIG_REL_PATH = '.ourcode/company.json'

/** company.json 里 mcp 段的形状。值用 'all' 或服务器名清单。 */
export interface CompanyMcpConfig {
  default?: McpGrantSpec
  roles?: Record<string, McpGrantSpec>
}

export interface ResolvedMcpGrant {
  grant: McpGrantSpec
  /** 生效授权 + 排除名单里点名的服务器（'all' 展开为空）——对账用。 */
  namedServers: string[]
}

/** 归一化一个授权值：容忍 'all'、含 'all' 的数组、空数组（→ 未声明）。 */
function normalizeGrant(v: unknown): McpGrantSpec | undefined {
  if (v === 'all') return 'all'
  if (Array.isArray(v)) {
    const items = Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean)))
    if (items.length === 0) return undefined
    if (items.includes('all')) return 'all'
    return items
  }
  return undefined
}

function companyConfigPath(projectPath: string): string {
  const root = (projectPath || '').replace(/[\\/]$/, '')
  return root ? `${root}/${COMPANY_CONFIG_REL_PATH}` : COMPANY_CONFIG_REL_PATH
}

// ── mtime 缓存：员工每次运行 + 看板面板打开都读一次，省重复 IO ──
interface CompanyConfigCache {
  path: string
  mtime: number
  config: CompanyMcpConfig
}
let _cache: CompanyConfigCache | null = null

function normalizeMcpSection(v: unknown): CompanyMcpConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const raw = v as Record<string, unknown>
  const config: CompanyMcpConfig = {}
  const def = normalizeGrant(raw.default)
  if (def !== undefined) config.default = def
  if (raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles)) {
    const roles: Record<string, McpGrantSpec> = {}
    for (const [role, value] of Object.entries(raw.roles as Record<string, unknown>)) {
      const grant = normalizeGrant(value)
      if (grant !== undefined) roles[role] = grant
    }
    if (Object.keys(roles).length > 0) config.roles = roles
  }
  return config
}

/** 读取并缓存项目 company.json 的 mcp 段。文件缺失/损坏按空配置处理（默认档 all 兜底）。 */
export async function loadCompanyMcpConfig(projectPath: string): Promise<CompanyMcpConfig> {
  const path = companyConfigPath(projectPath)
  const st = await window.electronAPI.stat(path).catch(() => null)
  const mtime = st?.isFile ? st.modifiedAt : 0
  if (_cache && _cache.path === path && _cache.mtime === mtime && mtime > 0) return _cache.config
  if (mtime === 0) {
    // 文件不存在：不缓存「缺失」状态（stat 很便宜），下次创建后立即可读
    return {}
  }
  let config: CompanyMcpConfig = {}
  try {
    const { content } = await window.electronAPI.readFile(path)
    const parsed = JSON.parse(content || '{}')
    config = normalizeMcpSection(parsed?.mcp)
  } catch {
    // 损坏的配置按缺省处理（默认档 all），不让员工体系整体瘫掉
    config = {}
  }
  _cache = { path, mtime, config }
  return config
}

/** 解析员工的有效 MCP 授权：看板分配 ∪ 角色文件声明，缺省 'all'。 */
export async function resolveWorkerMcpGrant(opts: {
  projectPath: string
  role: string
  defMcp?: string[]
  defMcpDeny?: string[]
}): Promise<ResolvedMcpGrant> {
  const config = await loadCompanyMcpConfig(opts.projectPath)
  const assigned = normalizeGrant(config.roles?.[opts.role]) ?? normalizeGrant(config.default) ?? 'all'
  const declared = normalizeGrant(opts.defMcp)
  const grant: McpGrantSpec =
    assigned === 'all' || declared === 'all'
      ? 'all'
      : Array.from(new Set([...(assigned as string[]), ...((declared as string[]) ?? [])]))
  // 对账名单 = 生效授权点名的 + 排除名单点名的（排除名失效同样该说话）
  const namedServers = Array.from(
    new Set([...(grant === 'all' ? [] : grant), ...(opts.defMcpDeny ?? [])]),
  )
  return { grant, namedServers }
}

/**
 * 对账：点名清单 vs 当前 MCP 目录，返回目录里找不到的服务器名。
 * 'all' 档没有名单、天然免疫；目录读取失败时不误报（返回空）。
 */
export async function reconcileMcpGrantServers(opts: {
  projectPath?: string
  namedServers: string[]
}): Promise<string[]> {
  if (opts.namedServers.length === 0) return []
  try {
    const status = await window.electronAPI.mcpStatus(opts.projectPath || undefined)
    const known = new Set((status || []).map((s) => s.name))
    return opts.namedServers.filter((n) => !known.has(n))
  } catch {
    return []
  }
}

/** 对账结果 → 注入员工动态上下文的告警块（空数组返回空串）。 */
export function buildMcpGrantWarning(missing: string[]): string {
  if (missing.length === 0) return ''
  return (
    `\n\n<mcp_grant_warning>角色授权清单中的 MCP 服务器 ${missing.join('、')} 未在当前 MCP 目录中找到` +
    `（可能已改名、已删除或未刷新 MCP 面板），相关工具本次不可用；` +
    `任务依赖它时请如实回报总监，由用户检查 mcp_config.json 或公司看板的「MCP 分配」。</mcp_grant_warning>`
  )
}

/**
 * 保存 mcp 段（看板 UI 用）：保留文件里其它顶层键，写回后失效缓存。
 * `.ourcode/` 目录可能尚不存在（无 targemode 的项目），先 ensureDir 再写。
 */
export async function saveCompanyMcpConfig(projectPath: string, mcp: CompanyMcpConfig): Promise<void> {
  const path = companyConfigPath(projectPath)
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  if (dir) {
    await window.electronAPI.createDir(dir)
  }
  let existing: Record<string, unknown> = {}
  const st = await window.electronAPI.stat(path).catch(() => null)
  if (st?.isFile) {
    try {
      const { content } = await window.electronAPI.readFile(path)
      const parsed = JSON.parse(content || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
    } catch {
      existing = {}
    }
  }
  existing.mcp = mcp
  await window.electronAPI.writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8')
  _cache = null
}
