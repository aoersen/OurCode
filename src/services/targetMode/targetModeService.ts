/**
 * Target-mode service: owns the `.ourcode/targemode/` state directory in the
 * workspace.
 *
 * The agent drives the actual workflow (goal doc, loops, logs) via tools, but
 * the code takes care of the bootstrap (directory skeleton + .gitignore) and
 * of surfacing the current status (round / progress) to both the system prompt
 * and the UI, so the state never depends on the model's memory.
 *
 * All fs access goes through `window.electronAPI.*` — paths are confined to
 * the project root (main-process allowedRoots guard).
 */

import { TARGET_MODE_SPEC_MD, TARGET_MODE_INDEX_INIT, TARGET_MODE_STATUS_INIT } from './spec'

const TARGET_MODE_DIR = '.ourcode/targemode'
const GITIGNORE_ENTRY = '.ourcode/targemode/'
const AGENTS_DIR = '.ourcode/agents'

/**
 * Target-mode role definitions written to the workspace `.ourcode/agents/`
 * (frontmatter + system prompt). `tm-` prefix keeps them distinct from
 * user-defined roles; existing files are never overwritten. The built-in
 * archetypes (requirement-analyst / tester) are the no-config fallback when
 * these are deleted.
 */
const TARGET_MODE_ROLE_TEMPLATES: Record<string, string> = {
  'tm-requirement-analyst': `---
name: tm-requirement-analyst
description: 需求分析师（目标模式）—— 澄清目标、产出可验证检查清单
tools: [read_file, read_multiple_files, list_directory, get_directory_tree, search_files, search_in_files, write_file, edit_file, create_directory]
allowedWritePaths: [.ourcode/targemode]
maxIterations: 8
temperature: 0.1
---
你是「tm-requirement-analyst」子智能体，由目标模式监管 Agent 派发，负责澄清目标并产出可验证的检查清单。
- 可读全仓（理解现状），但只写 .ourcode/targemode/ 下的文档，绝不修改业务代码。
- 产出必须结构化：需求条目、检查清单（每项标注可验证性类别：auto=可机器验证 / code=需代码审查 / manual=需人工确认）、假设与待确认项。
- 完成后报告：写了哪些文件、检查清单的类别分布、遗留待确认项。
`,
  'tm-developer': `---
name: tm-developer
description: 研发（目标模式）—— 实现业务逻辑、数据模型、API
maxIterations: 15
maxTokensBudget: 150000
temperature: 0.1
---
你是「tm-developer」子智能体，由目标模式监管 Agent 派发，负责实现业务逻辑、数据模型、API。
- 权限为全量工具（除控制类），但只改任务信封 files_to_modify 声明的文件；如需改动未声明文件，先停止并报告，不要擅自扩大范围。
- 完成后必须报告：改了哪些文件、是否运行过 typecheck 与测试（贴出原始输出）。
`,
  'tm-ui-developer': `---
name: tm-ui-developer
description: UI 开发（目标模式）—— 实现界面、交互、样式
maxIterations: 12
maxTokensBudget: 120000
temperature: 0.1
---
你是「tm-ui-developer」子智能体，由目标模式监管 Agent 派发，负责实现界面、交互、样式。
- 权限为全量工具（除控制类），但只改任务信封 files_to_modify 声明的文件。
- 若存在 agents/interface_spec.md，先读取并遵循其中的接口契约。
- 完成后必须报告：改了哪些文件、是否运行过 typecheck 与测试。
`,
  'tm-tester': `---
name: tm-tester
description: 独立测试验证（目标模式）—— 不修改业务代码
tools: [read_file, read_multiple_files, list_directory, get_directory_tree, search_files, search_in_files, write_file, edit_file, multi_edit_file, create_directory, delete_file, run_command]
allowedWritePaths: [.ourcode/targemode, src/__tests__, tests, test]
maxIterations: 10
maxTokensBudget: 120000
temperature: 0.1
---
你是「tm-tester」子智能体，由目标模式监管 Agent 派发，独立验证实现是否满足验收标准。
- 可读全仓（理解被测对象），但只写测试文件与测试报告，绝不修改业务代码。
- 报告必须逐条对照验收标准给出 通过/失败/缺陷，并引用证据（测试名 / 文件:行 / 命令输出）；无证据的"通过"不计入。
- 验证必须运行 typecheck 与测试，贴出原始输出。
`,
}

/** Placeholder content for the targemode sub-directories (agents/ inbox/). */
const TARGET_MODE_DIR_README = '# 本目录由监管 Agent 维护。\n'

/** 监管决策日志模板（追加式：一行一条 派发决策 + 理由）。 */
const SUPERVISOR_LOG_INIT = '# 监管决策日志\n\n每次派发决策追加一行：`[时间] 派发 <角色> 执行 <任务> —— <理由>`。\n'

/** 全局 token 预算模板（budget.ts 负责代码级累计与触顶，此文件仅作可见配置与审计）。 */
const BUDGET_INIT = `# 目标模式预算

- 总消耗上限（tokens）：2000000（可修改）
- 当前累计：0
- 触顶后停止自主续跑并询问用户。
`

/** Parse target-mode dir paths as `<root>/.ourcode/targemode/<rel>`. */
function join(root: string, ...rel: string[]): string {
  return [root.replace(/[\\/]+$/, ''), TARGET_MODE_DIR, ...rel].join('/')
}

/** Parse round / progress out of implementationStatus.md (loose on purpose —
 *  the file is model-maintained, so match the spec's field names leniently). */
export interface TargetModeStatus {
  round: number | null
  percent: number | null
  progressText: string
  /** 实施进度里的阶段信息（如 "阶段 3/5"），宽松解析，缺省 null。 */
  stageCurrent: number | null
  stageTotal: number | null
}

export function parseStatus(md: string): TargetModeStatus {
  const roundMatch = md.match(/当前轮次[：:]\s*(\d+)/)
  const percentMatch = md.match(/总体百分比[：:]\s*(\d+(?:\.\d+)?)\s*%/)
  const progressMatch = md.match(/实施进度[：:]\s*([^\n]+)/)
  const progressText = progressMatch?.[1]?.trim() || ''
  let stageCurrent: number | null = null
  let stageTotal: number | null = null
  const stageMatch = progressText.match(/阶段\s*(\d+)\s*\/\s*(\d+)/)
  if (stageMatch) {
    stageCurrent = parseInt(stageMatch[1], 10)
    stageTotal = parseInt(stageMatch[2], 10)
  }
  return {
    round: roundMatch ? parseInt(roundMatch[1], 10) : null,
    percent: percentMatch ? parseFloat(percentMatch[1]) : null,
    progressText,
    stageCurrent,
    stageTotal,
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    const { content } = await window.electronAPI.readFile(path)
    return content
  } catch {
    return ''
  }
}

async function safeWriteIfMissing(path: string, content: string): Promise<void> {
  if (await safeRead(path) !== '') return
  try {
    await window.electronAPI.writeFile(path, content, 'utf-8')
  } catch (e) {
    console.error('目标模式初始化写入失败:', path, e)
  }
}

async function safeCreateDir(path: string): Promise<void> {
  try {
    await window.electronAPI.createDir(path)
  } catch {
    // Already exists — fine (main-process mkdir is non-recursive)
  }
}

/** Ensure `.gitignore` in the project root lists `.ourcode/targemode/`. */
async function ensureGitIgnore(root: string): Promise<void> {
  const gitignorePath = `${root.replace(/[\\/]+$/, '')}/.gitignore`
  const content = await safeRead(gitignorePath)
  const lines = content.split(/\r?\n/)
  if (lines.some((l) => l.trim() === GITIGNORE_ENTRY)) return
  try {
    const addition = (content && !content.endsWith('\n') ? '\n' : '') + GITIGNORE_ENTRY + '\n'
    await window.electronAPI.writeFile(gitignorePath, content + addition, 'utf-8')
  } catch (e) {
    console.error('目标模式 .gitignore 更新失败:', e)
  }
}

/**
 * Bootstrap the `.ourcode/targemode/` skeleton (idempotent): dirs, SPEC.md,
 * index.md, implementationStatus.md, .gitignore entry, plus the v2
 * multi-agent surface — agents/ inbox/ sub-dirs, budget.md / supervisor.md
 * templates and the editable `tm-*.md` role definitions in `.ourcode/agents/`
 * (never overwriting existing files). Failures are logged and swallowed —
 * target mode degrades to prompt-only rather than breaking the chat.
 */
export async function ensureInitialized(root: string): Promise<void> {
  if (!root) return
  const base = root.replace(/[\\/]+$/, '')
  try {
    await safeCreateDir(`${base}/.ourcode`)
    await safeCreateDir(join(root))
    await safeWriteIfMissing(join(root, 'SPEC.md'), TARGET_MODE_SPEC_MD)
    await safeWriteIfMissing(join(root, 'index.md'), TARGET_MODE_INDEX_INIT)
    await safeWriteIfMissing(join(root, 'implementationStatus.md'), TARGET_MODE_STATUS_INIT)
    await ensureGitIgnore(root)

    // v2 multi-agent surface: sub-agent artifacts + envelope inbox + templates.
    await safeCreateDir(join(root, 'agents'))
    await safeCreateDir(join(root, 'inbox'))
    await safeWriteIfMissing(join(root, 'agents/README.md'), TARGET_MODE_DIR_README)
    await safeWriteIfMissing(join(root, 'inbox/README.md'), TARGET_MODE_DIR_README)
    await safeWriteIfMissing(join(root, 'budget.md'), BUDGET_INIT)
    await safeWriteIfMissing(join(root, 'agents/supervisor.md'), SUPERVISOR_LOG_INIT)

    // Editable role definitions (tm- prefix, never overwrite existing files).
    await safeCreateDir(`${base}/${AGENTS_DIR}`)
    for (const [name, content] of Object.entries(TARGET_MODE_ROLE_TEMPLATES)) {
      await safeWriteIfMissing(`${base}/${AGENTS_DIR}/${name}.md`, content)
    }
  } catch (e) {
    console.error('目标模式初始化失败:', e)
  }
}

/** Read the current implementationStatus.md ('' when missing/unreadable). */
export async function readStatusText(root: string): Promise<string> {
  if (!root) return ''
  return safeRead(join(root, 'implementationStatus.md'))
}

/** Read + parse the current target-mode status, or null when unavailable. */
export async function readStatus(root: string): Promise<TargetModeStatus | null> {
  const md = await readStatusText(root)
  if (!md) return null
  return parseStatus(md)
}
