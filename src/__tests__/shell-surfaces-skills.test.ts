import { describe, expect, it } from 'vitest'
import type { SkillInfo } from '@/services/skills/skillManager'
import type { SkillConfig } from '@/services/skills/skillRegistry'
import {
  buildSkillRows,
  filterSkills,
  originFromPath,
  parseSkillInstallInput,
  skillCounts,
  skillMetaLine,
  skillSourceLabel,
  skillStateWord,
  skillToggleLabel,
} from '@/shell/agent/surfaces/skills/skillsModel'

function skill(over: Partial<SkillInfo> & { name: string }): SkillInfo {
  return {
    description: '',
    source: 'global',
    path: `C:\\skills\\${over.name}\\SKILL.md`,
    content: '',
    mtime: 1,
    ...over,
  } as SkillInfo
}

const GLOBAL_ROOT = 'C:\\Users\\me\\.ourcode'
const PROJECT_ROOT = 'E:\\ls\\ideUtil\\OurCode-ide'

const skills: SkillInfo[] = [
  skill({ name: 'code-review', description: '审查改动' }),
  skill({ name: 'deploy', description: '部署' }),
  skill({ name: 'proj-skill', source: 'project', projectPath: PROJECT_ROOT }),
  skill({ name: 'builtin-one', builtin: true }),
]

const configs: Record<string, SkillConfig> = {
  [GLOBAL_ROOT]: {
    skills: {
      deploy: { enabled: false, version: '1.2.0', importedFrom: 'claude' },
      'code-review': { version: '0.9.0' },
    },
  },
  [PROJECT_ROOT]: { skills: {} },
}

function rows() {
  return buildSkillRows({
    skills,
    rootOf: (entry) => (entry.source === 'global' ? GLOBAL_ROOT : entry.projectPath || ''),
    configOf: (root) => configs[root],
  })
}

describe('skillsModel · 组装', () => {
  it('enabled 读 skills.json，缺省视为启用；内置永远启用', () => {
    const list = rows()
    const byName = new Map(list.map((row) => [row.name, row]))
    expect(byName.get('deploy')?.enabled).toBe(false)
    expect(byName.get('code-review')?.enabled).toBe(true)
    expect(byName.get('builtin-one')?.enabled).toBe(true)
    expect(byName.get('builtin-one')?.builtin).toBe(true)
  })

  it('版本与导入来源从配置里带出来', () => {
    const deploy = rows().find((row) => row.name === 'deploy')
    expect(deploy?.version).toBe('1.2.0')
    expect(deploy?.importedFrom).toBe('claude')
    expect(deploy?.configRoot).toBe(GLOBAL_ROOT)
  })

  it('排序：启用在前，内置在启用组内靠前，同组按名字', () => {
    expect(rows().map((row) => row.name)).toEqual(['builtin-one', 'code-review', 'proj-skill', 'deploy'])
  })
})

describe('skillsModel · 搜索与文案', () => {
  it('按名字或描述过滤', () => {
    expect(filterSkills(rows(), 'REVIEW').map((row) => row.name)).toEqual(['code-review'])
    expect(filterSkills(rows(), '部署').map((row) => row.name)).toEqual(['deploy'])
    expect(filterSkills(rows(), '')).toHaveLength(4)
  })

  it('状态词与开关文案分得清「现在是什么」和「点了做什么」', () => {
    const list = rows()
    const deploy = list.find((row) => row.name === 'deploy')!
    const builtin = list.find((row) => row.name === 'builtin-one')!
    expect(skillStateWord(deploy)).toBe('已停用')
    expect(skillToggleLabel(deploy)).toBe('启用')
    expect(skillStateWord(builtin)).toBe('内置')
    expect(skillToggleLabel(builtin)).toBe('停用')
  })

  it('来源与元信息行', () => {
    const list = rows()
    const deploy = list.find((row) => row.name === 'deploy')!
    const projectSkill = list.find((row) => row.name === 'proj-skill')!
    expect(skillSourceLabel(deploy)).toBe('全局')
    expect(skillSourceLabel(projectSkill)).toBe('OurCode-ide')
    expect(skillMetaLine(deploy)).toBe('v1.2.0 · 全局 · 来自 claude')
    expect(skillMetaLine(projectSkill)).toBe('OurCode-ide')
  })

  it('计数', () => {
    expect(skillCounts(rows())).toEqual({ total: 4, enabled: 3, disabled: 1 })
    expect(skillCounts([])).toEqual({ total: 0, enabled: 0, disabled: 0 })
  })
})

describe('skillsModel · 安装输入', () => {
  it('纯名字按注册表装', () => {
    expect(parseSkillInstallInput('  code-review ')).toEqual({ target: { kind: 'registry', name: 'code-review' } })
  })

  it('路径按本地目录导入，名字取末段', () => {
    expect(parseSkillInstallInput('E:\\skills\\code-review')).toEqual({
      target: { kind: 'path', name: 'code-review', path: 'E:\\skills\\code-review', origin: 'agents' },
    })
  })

  it('路径里的平台目录决定 provenance', () => {
    expect(originFromPath('C:\\Users\\me\\.claude\\skills\\review')).toBe('claude')
    expect(originFromPath('/home/me/.cursor/skills/review')).toBe('cursor')
    expect(originFromPath('/home/me/.agents/skills/review')).toBe('agents')
    expect(originFromPath('E:\\my-skills\\review')).toBe('agents')
  })

  it('空输入与非法名字给可读错误', () => {
    expect(parseSkillInstallInput('   ')).toEqual({ error: '请输入技能名或本地技能目录路径' })
    expect(parseSkillInstallInput('bad name!')).toEqual({ error: '技能名只能包含字母、数字、点、下划线与连字符' })
  })
})
