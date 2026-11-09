/**
 * Office 面的「落地契约」守护测试（静态扫描 src/shell/office/**）。
 *
 * 把任务书里的硬规则变成会失败的断言，防止后续重构悄悄破坏：
 *  1. 只用 pure token，不写十六进制色值；
 *  2. 只有三处阴影可用（而且本面其实一个都不用）；
 *  3. 圆角只有 12px 容器与胶囊；
 *  4. 目标模式开关必须接真实 action（chatStore.setTargetMode）；
 *  5. 不引用旧 Office 组件（复用数据契约，不复用样式）；
 *  6. 不引入新依赖；OfficeSurface 是对外唯一入口（default export + onClose）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const OFFICE_DIR = join(process.cwd(), 'src', 'shell', 'office')

function officeFiles(): string[] {
  return readdirSync(OFFICE_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .sort()
}

function readOffice(name: string): string {
  return readFileSync(join(OFFICE_DIR, name), 'utf8')
}

function allSource(): Array<{ name: string; text: string }> {
  return officeFiles().map((name) => ({ name, text: readOffice(name) }))
}

describe('office 面：视觉与依赖契约', () => {
  it('没有十六进制色值（只用 --pure-* token）', () => {
    const offenders = allSource()
      .filter(({ text }) => /#[0-9a-fA-F]{3,8}\b/.test(text))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it('阴影只用 pure 的三种之一（本面实际零阴影）', () => {
    const allowed = new Set(['pure-soft-shadow', 'pure-card-shadow', 'pure-shadow-pop'])
    const offenders: string[] = []
    for (const { name, text } of allSource()) {
      const matches = text.match(/\b[a-z-]*shadow[a-z-]*\b/g) ?? []
      for (const token of matches) {
        if (allowed.has(token)) continue
        offenders.push(`${name}:${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('圆角只有 12px 容器 / 胶囊 / 无圆角', () => {
    const allowed = new Set(['rounded-xl', 'rounded-full', 'rounded-none', 'rounded-br', 'rounded-bl'])
    const offenders: string[] = []
    for (const { name, text } of allSource()) {
      for (const token of text.match(/\brounded(-[a-z0-9[\]-]+)?(?=["\s`])/g) ?? []) {
        if (allowed.has(token)) continue
        offenders.push(`${name}:${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('没有彩色 chip / 徽章底色（只允许 pure token 的 bg）', () => {
    const offenders: string[] = []
    for (const { name, text } of allSource()) {
      // bg-white / bg-[var(--pure-*)] 之外不允许出现 bg-<palette>-<shade>
      for (const token of text.match(/\bbg-(?!white|transparent|\[var\(--pure)[a-z]+-\d{2,3}\b/g) ?? []) {
        offenders.push(`${name}:${token}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('office 面：接线契约', () => {
  it('目标模式开关接的是真实 action（chatStore.setTargetMode）', () => {
    const wiring = readOffice('useOfficeView.ts')
    expect(wiring).toContain('setTargetMode(id, current.targetMode !== true)')
  })

  it('没有可挂的会话时开关是只读状态（available=false 时 UI 会 disabled）', () => {
    const topRow = readOffice('OfficeTopRow.tsx')
    expect(topRow).toContain('disabled={!goalMode.available}')
    expect(topRow).toContain('role="switch"')
  })

  it('不复用旧 Office 组件的样式（只允许 import 数据层 service）', () => {
    const offenders = allSource()
      .filter(({ text }) => text.includes("from '@/components/Office"))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it('不引入新依赖：外部 import 只有 react', () => {
    const external = new Set<string>()
    for (const { text } of allSource()) {
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1]
        if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('@shared/')) continue
        external.add(spec)
      }
    }
    expect([...external].sort()).toEqual(['react'])
  })

  it('OfficeSurface 是唯一对外的面：default export + onClose', () => {
    const surface = readOffice('OfficeSurface.tsx')
    expect(surface).toMatch(/export default function OfficeSurface\(\{ onClose \}: OfficeSurfaceProps\)/)
    expect(surface).toContain('onClose: () => void')
    expect(surface).toContain('data-testid="office-surface"')
    // 三栏是 flex 兄弟节点，不是绝对定位面板
    expect(surface).not.toContain('absolute')
  })

  it('缺数据的指标必须显式标成未接入，而不是编数字', () => {
    const model = readOffice('officeModel.ts')
    expect(model).toContain("value: '未接入'")
    expect(model).toContain('wired: false')
  })

  it('键盘可达：三栏列表都有 roving 选择（↑/↓ + Enter）', () => {
    for (const name of ['RoleList.tsx', 'TaskFlow.tsx', 'PendingPanel.tsx', 'ChecklistPanel.tsx']) {
      const text = readOffice(name)
      expect(text, `${name} 应该用 useRovingList`).toContain('useRovingList')
      expect(text, `${name} 应该是 role="list"`).toContain('role="list"')
    }
  })
})
