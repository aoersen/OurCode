/**
 * Target-mode task envelope — the data contract between the supervisor (main
 * loop) and `run_subagent` (v2, §3.3 / §13).
 *
 * The envelope is parsed ONLY here, on the target-mode side. The shared
 * `subagentRunner` never parses task text: the ToolRegistry's run_subagent
 * fork is the single call site that recognizes an envelope (target-mode
 * sessions only), so a plain run_subagent task that happens to start with `---`
 * can never be misinterpreted (isolation by construction).
 */
import { sanitizeModelName } from '@/services/subagents/subagentReport'

export interface TaskEnvelope {
  /** 信封派发对象（角色名，如 tm-tester） */
  to: string
  type?: string
  phase?: string
  status?: string
  /** files_to_modify — 本次运行允许修改的文件（硬隔离为写范围） */
  filesToModify: string[]
  filesToRead: string[]
  acceptance?: string
  fixAttempts: number
  /** 可选角色模型（SubAgentOptions.model） */
  model?: string
  /** 可选全文报告写入路径（SubAgentOptions.reportPath） */
  reportPath?: string
  /** 信封正文（frontmatter 之后的任务描述） */
  prompt: string
}

function parseList(raw?: string): string[] {
  if (!raw) return []
  let s = raw.trim()
  // Drop trailing YAML comments (`[src/a.ts]  # 允许改的文件`) — the supervisor
  // may copy the template's commented example verbatim.
  const hash = s.indexOf(' #')
  if (hash >= 0) s = s.slice(0, hash).trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s
    .split(',')
    .map((x) => x.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
}

/**
 * Sanitize the envelope's optional `model:` field. The supervisor LLM often
 * copies the template verbatim (`model: <可选…>`), wraps the name in quotes
 * (`model: "deepseek-chat"`) or writes placeholder junk (`undefined` /
 * `optional` / 空串） — any of these would reach resolveSubagentModel as a
 * truthy override and get sent to the API as a bogus model id
 * (HTTP 400 "Unsupported model"). Delegates to the shared sanitizeModelName
 * so the runner-side fallback chain applies the exact same cleaning rules.
 */
const sanitizeModelField = sanitizeModelName

/**
 * Parse a task envelope out of a run_subagent prompt. Returns null when the
 * text is not an envelope: no frontmatter, or a frontmatter without the
 * envelope marker `to:` (a plain task that starts with `---` won't match).
 */
export function parseEnvelope(task: string): TaskEnvelope | null {  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(task || '')
  if (!m) return null

  const lines = m[1].split(/\r?\n/)
  const fm: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i].trim())
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let value = kv[2].trim()
    // Block scalar (`acceptance: |`) — collect the following indented lines.
    if (value === '|' || value === '>') {
      const block: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (next.trim() === '' || /^\s+\S/.test(next)) {
          block.push(next.trim())
          i++
        } else break
      }
      value = block.join('\n')
    }
    fm[key] = value
  }

  const to = fm.to || ''
  if (!to) return null

  return {
    to,
    type: fm.type || undefined,
    phase: fm.phase || undefined,
    status: fm.status || undefined,
    filesToModify: parseList(fm.files_to_modify),
    filesToRead: parseList(fm.files_to_read),
    acceptance: fm.acceptance || undefined,
    fixAttempts: fm.fix_attempts !== undefined ? parseInt(fm.fix_attempts, 10) || 0 : 0,
    model: sanitizeModelField(fm.model),
    reportPath: fm.report_path || undefined,
    prompt: task.slice(m[0].length).trim(),
  }
}

/** run_subagent option overrides derived from a parsed envelope (v2 §13.1). */
export interface EnvelopeOverrides {
  name?: string
  model?: string
  writePaths?: string[]
  reportPath?: string
  statusLine?: boolean
}

/**
 * Map a parsed envelope onto run_subagent option overrides. Extracted so the
 * ToolRegistry fork (the only caller) stays a thin gate: normal-mode sessions
 * never reach it, and the mapping itself is unit-testable.
 */
export function envelopeToOverrides(envelope: TaskEnvelope): EnvelopeOverrides {
  const o: EnvelopeOverrides = { statusLine: true }
  if (envelope.to) o.name = envelope.to
  if (envelope.model) o.model = envelope.model
  if (envelope.filesToModify.length > 0) o.writePaths = envelope.filesToModify
  if (envelope.reportPath) o.reportPath = envelope.reportPath
  return o
}
