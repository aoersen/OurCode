import { describe, it, expect } from 'vitest'
import {
  analyzeActionDanger,
  checkAppAllowed,
  looksLikeCredential,
  matchesDenyList,
} from '@shared/computerPolicy'

describe('computerPolicy — application allow/deny', () => {
  it('refuses password managers, banking and UAC windows by default', () => {
    expect(matchesDenyList('1Password')).toBeTruthy()
    expect(matchesDenyList('Bitwarden — 保险库')).toBeTruthy()
    expect(matchesDenyList('KeePass')).toBeTruthy()
    expect(matchesDenyList('招商银行 专业版')).toBeTruthy()
    expect(matchesDenyList('用户账户控制')).toBeTruthy()
    expect(matchesDenyList('注册表编辑器')).toBeTruthy()
  })

  it('allows an ordinary editor window', () => {
    expect(matchesDenyList('notepad 无标题 - 记事本')).toBeNull()
    expect(checkAppAllowed('notepad 无标题 - 记事本', {})).toEqual({ allowed: true })
  })

  it('honours a custom deny list and the allowlist mode', () => {
    const denied = checkAppAllowed('微信 WeChat', { computerUseAppDenylist: ['微信'] })
    expect(denied.allowed).toBe(false)

    const allowlistOff = checkAppAllowed('notepad 记事本', {
      computerUseAllowlistMode: true,
      computerUseAppAllowlist: ['excel'],
    })
    expect(allowlistOff.allowed).toBe(false)

    const allowlistOn = checkAppAllowed('excel 工作簿1', {
      computerUseAllowlistMode: true,
      computerUseAppAllowlist: ['excel'],
    })
    expect(allowlistOn.allowed).toBe(true)
  })
})

describe('computerPolicy — action danger', () => {
  it('flags irreversible verbs on click targets', () => {
    expect(analyzeActionDanger({ kind: 'click', appIdentity: 'x', targetLabel: 'button "删除"' }).danger).toBeTruthy()
    expect(analyzeActionDanger({ kind: 'click', appIdentity: 'x', targetLabel: 'button "支付"' }).danger).toBeTruthy()
    expect(analyzeActionDanger({ kind: 'click', appIdentity: 'x', targetLabel: 'button "发送"' }).danger).toBeTruthy()
    expect(analyzeActionDanger({ kind: 'click', appIdentity: 'x', targetLabel: 'button "保存"' }).danger).toBeUndefined()
  })

  it('flags credential-looking input and refuses to type it', () => {
    expect(looksLikeCredential('123456')).toBe(true)
    expect(looksLikeCredential('Abcdef123456xy')).toBe(true)
    expect(looksLikeCredential('会议纪要')).toBe(false)
    expect(analyzeActionDanger({ kind: 'type', appIdentity: 'x', text: '123456' }).danger).toBeTruthy()
  })

  it('flags executables launched from a downloads folder', () => {
    expect(
      analyzeActionDanger({ kind: 'launch', appIdentity: 'x', path: 'C:\\Users\\me\\Downloads\\setup.exe' }).danger,
    ).toBeTruthy()
    expect(analyzeActionDanger({ kind: 'launch', appIdentity: 'x', path: 'notepad' }).danger).toBeUndefined()
  })
})
