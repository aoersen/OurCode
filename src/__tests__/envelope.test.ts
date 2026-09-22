import { describe, it, expect } from 'vitest'
import { parseEnvelope, envelopeToOverrides } from '@/services/targetMode/envelope'

describe('targetMode envelope', () => {
  it('parses a valid task envelope', () => {
    const task = `---
from: supervisor
to: tm-tester
type: fix
phase: 2
status: pending
files_to_modify: [src/a.ts, src/b.ts]
files_to_read: [agents/interface_spec.md]
acceptance: 全部通过
fix_attempts: 1
model: gpt-4o
report_path: .ourcode/targemode/agents/test_report.md
---
## 任务
验证实现。
`
    const env = parseEnvelope(task)
    expect(env).not.toBeNull()
    expect(env!.to).toBe('tm-tester')
    expect(env!.type).toBe('fix')
    expect(env!.phase).toBe('2')
    expect(env!.filesToModify).toEqual(['src/a.ts', 'src/b.ts'])
    expect(env!.filesToRead).toEqual(['agents/interface_spec.md'])
    expect(env!.acceptance).toBe('全部通过')
    expect(env!.fixAttempts).toBe(1)
    expect(env!.model).toBe('gpt-4o')
    expect(env!.reportPath).toBe('.ourcode/targemode/agents/test_report.md')
    expect(env!.prompt).toContain('## 任务')
  })

  it('parses a block-scalar acceptance', () => {
    const env = parseEnvelope('---\nto: dev\nacceptance: |\n  1. 通过测试\n  2. 无回归\n---\nbody')
    expect(env!.acceptance).toBe('1. 通过测试\n2. 无回归')
  })

  it('returns null for plain tasks (no envelope frontmatter)', () => {
    expect(parseEnvelope('修复 src/a.ts 的 bug')).toBeNull()
  })

  it('returns null for frontmatter without the to: marker (not an envelope)', () => {
    expect(parseEnvelope('---\ntitle: hello\n---\nbody')).toBeNull()
  })

  it('tolerates quoted list items', () => {
    const env = parseEnvelope('---\nto: dev\nfiles_to_modify: ["src/a.ts", \'src/b.ts\']\n---\ntask')
    expect(env!.filesToModify).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips trailing YAML comments from list values', () => {
    const env = parseEnvelope('---\nto: dev\nfiles_to_modify: [src/a.ts]  # 允许改的文件，互不重叠\n---\ntask')
    expect(env!.filesToModify).toEqual(['src/a.ts'])
  })

  it('defaults missing numeric/list fields', () => {
    const env = parseEnvelope('---\nto: dev\n---\ntask')
    expect(env!.filesToModify).toEqual([])
    expect(env!.filesToRead).toEqual([])
    expect(env!.fixAttempts).toBe(0)
    expect(env!.model).toBeUndefined()
    expect(env!.reportPath).toBeUndefined()
  })

  it('drops junk model values (template placeholder / undefined / none)', () => {
    // 监管 LLM 常原样照抄信封模板的 model: 注释、或写 undefined/none 等占位——
    // 这些一旦当作模型名发出去就是 400 "Unsupported model"，必须清洗掉。
    expect(parseEnvelope('---\nto: dev\nmodel: <可选，该角色使用的模型>\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: undefined\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: none\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel:   \n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: deepseek-chat\n---\nx')!.model).toBe('deepseek-chat')
  })

  it('strips quotes / rejects non-id model values in the envelope', () => {
    // 监管常在信封里给模型名加引号、写 optional、或塞一句中文说明 ——
    // 这些都会直达 API 造成 400，必须在解析层清洗。
    expect(parseEnvelope('---\nto: dev\nmodel: "deepseek-chat"\n---\nx')!.model).toBe('deepseek-chat')
    expect(parseEnvelope('---\nto: dev\nmodel: \'deepseek-chat\'\n---\nx')!.model).toBe('deepseek-chat')
    expect(parseEnvelope('---\nto: dev\nmodel: optional\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: gpt 4o\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: 深度求索模型\n---\nx')!.model).toBeUndefined()
    expect(parseEnvelope('---\nto: dev\nmodel: deepseek-chat  # 用便宜的\n---\nx')!.model).toBe('deepseek-chat')
  })
})

describe('envelopeToOverrides (v2 §13.1 — envelope → run_subagent options)', () => {
  it('maps all envelope fields onto option overrides', () => {
    const env = parseEnvelope(
      '---\nto: tm-tester\nmodel: gpt-4o\nfiles_to_modify: [src/a.ts]\nreport_path: .ourcode/targemode/agents/r.md\n---\nx',
    )!
    expect(envelopeToOverrides(env)).toEqual({
      name: 'tm-tester',
      model: 'gpt-4o',
      writePaths: ['src/a.ts'],
      reportPath: '.ourcode/targemode/agents/r.md',
      statusLine: true,
    })
  })

  it('omits absent fields; empty files_to_modify does not tighten the write scope', () => {
    const env = parseEnvelope('---\nto: dev\n---\nx')!
    const o = envelopeToOverrides(env)
    expect(o.statusLine).toBe(true)
    expect(o.model).toBeUndefined()
    expect(o.reportPath).toBeUndefined()
    expect(o.writePaths).toBeUndefined()
  })
})
