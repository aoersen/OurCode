/**
 * 「技能」面的视图模型（纯函数）。
 *
 * 技能的事实来源是两个既有 service：
 *  - `services/skills/skillManager.ts`：listAllSkills（全局 + 各项目的 SKILL.md）
 *  - `services/skills/skillRegistry.ts`：skills.json 的 enabled/version/importedFrom
 *
 * 这里把「一次扫描的结果 + 每个 root 的 skills.json」组装成行，并负责搜索、
 * 状态词、安装输入的解析。读写 skills.json 仍然走 service 的既有函数。
 */
import type { SkillInfo, SkillOrigin } from '@/services/skills/skillManager'
import type { SkillConfig } from '@/services/skills/skillRegistry'
import { lastPathSegment, matchesQuery } from '../surfaceModel'

export interface SkillRow extends SkillInfo {
  enabled: boolean
  version?: string
  importedFrom?: SkillOrigin
  /** 决定 enabled 的那份 skills.json 的根（全局根或项目根） */
  configRoot: string
}

export interface SkillRowInput {
  skills: ReadonlyArray<SkillInfo>
  /** 技能 → 配置根；全局 = getGlobalRoot()，项目 = 项目根 */
  rootOf: (skill: SkillInfo) => string
  configOf: (root: string) => SkillConfig | undefined
}

/** 已安装列表：enabled 前置、同状态按名字排（列表稳定，不随扫描顺序跳）。 */
export function buildSkillRows(input: SkillRowInput): SkillRow[] {
  const rows: SkillRow[] = input.skills.map((skill) => {
    const configRoot = input.rootOf(skill)
    const config = input.configOf(configRoot)
    const entry = config?.skills?.[skill.name]
    return {
      ...skill,
      // 内置技能永远启用（skillRegistry.isSkillEnabled 的口径）
      enabled: skill.builtin ? true : entry?.enabled !== false,
      version: entry?.version,
      importedFrom: entry?.importedFrom,
      configRoot,
    }
  })

  return rows.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function filterSkills(rows: ReadonlyArray<SkillRow>, query: string): SkillRow[] {
  return rows.filter((row) => matchesQuery(row.name, query) || matchesQuery(row.description, query))
}

export function skillStateWord(row: SkillRow): string {
  if (row.builtin) return '内置'
  return row.enabled ? '已启用' : '已停用'
}

/** 纯文字开关的文案（点它是「做什么」，不是「现在是什么」）。 */
export function skillToggleLabel(row: SkillRow): string {
  return row.enabled ? '停用' : '启用'
}

/** 来源：全局 / 项目名。 */
export function skillSourceLabel(row: SkillRow): string {
  return row.source === 'global' ? '全局' : lastPathSegment(row.projectPath) || '项目'
}

/** 行尾的灰字：版本 · 来源 · 导入来源。 */
export function skillMetaLine(row: SkillRow): string {
  const parts: string[] = []
  if (row.version) parts.push(`v${row.version}`)
  parts.push(skillSourceLabel(row))
  if (row.importedFrom) parts.push(`来自 ${row.importedFrom}`)
  return parts.join(' · ')
}

export function skillCounts(rows: ReadonlyArray<SkillRow>): { total: number; enabled: number; disabled: number } {
  let enabled = 0
  for (const row of rows) if (row.enabled) enabled += 1
  return { total: rows.length, enabled, disabled: rows.length - enabled }
}

export type SkillInstallTarget =
  | { kind: 'registry'; name: string }
  | { kind: 'path'; name: string; path: string; origin: SkillOrigin }

/** 本地目录里可识别的平台标记（用于 importSkill 的 provenance 显示）。 */
const ORIGIN_MARKERS: ReadonlyArray<{ marker: string; origin: SkillOrigin }> = [
  { marker: '.claude', origin: 'claude' },
  { marker: '.cursor', origin: 'cursor' },
  { marker: '.zcode', origin: 'zcode' },
  { marker: '.opencode', origin: 'opencode' },
  { marker: '.gemini', origin: 'gemini' },
  { marker: '.windsurf', origin: 'windsurf' },
  { marker: '.agents', origin: 'agents' },
]

/** 从路径推断来源平台；识别不出时按跨工具目录 `.agents` 处理。 */
export function originFromPath(path: string): SkillOrigin {
  const normalized = path.replace(/\\/g, '/')
  const found = ORIGIN_MARKERS.find((entry) => normalized.split('/').includes(entry.marker))
  return found ? found.origin : 'agents'
}

/**
 * 「安装」输入解析：既接受注册表里的技能名，也接受一个本地技能目录路径。
 *  - 注册表名 → installSkill(name, root)
 *  - 本地路径 → importSkill(名字取末段, root, path, origin)
 */
export function parseSkillInstallInput(input: string): { target: SkillInstallTarget } | { error: string } {
  const value = input.trim()
  if (!value) return { error: '请输入技能名或本地技能目录路径' }

  const looksLikePath = /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value)
  if (looksLikePath) {
    const name = lastPathSegment(value)
    if (!name) return { error: '路径末尾没有技能目录名' }
    return { target: { kind: 'path', name, path: value, origin: originFromPath(value) } }
  }

  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return { error: '技能名只能包含字母、数字、点、下划线与连字符' }
  }
  return { target: { kind: 'registry', name: value } }
}
