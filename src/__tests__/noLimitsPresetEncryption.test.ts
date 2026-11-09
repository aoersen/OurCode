import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { NO_LIMITS_PRESETS } from '@/services/noLimits/presets'

/**
 * 「预设正文不以明文入库」的守卫。
 *
 * 这一组用例同时守住两件事：
 *  1. 仓库里没有 `*.md` 明文预设（本地 `presets:decode` 之后忘了 encode 会在这里失败）；
 *  2. `*.zh.enc.json` 是可解密、不含 CJK 明文的密文载荷。
 * 解密本身由 `index.ts` 的顶层 await 完成，下面的正文断言即验证解密链路。
 */

const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'services', 'noLimits', 'presets')

const CIPHERTEXT_FILES = ['dsh-purge.zh.enc.json', 'keyijiang.zh.enc.json']
const MARKDOWN_ALLOWLIST = new Set(['NOTICE.md', 'README.md'])

describe('提示词预设加密存储', () => {
  it('仓库里没有明文预设文件', () => {
    const leaked = readdirSync(PRESET_DIR).filter(
      (name) => name.endsWith('.md') && !MARKDOWN_ALLOWLIST.has(name),
    )
    expect(leaked, '明文预设不应出现在仓库里（先跑 npm run presets:encode）').toEqual([])
  })

  it('密文载荷结构合法且不含 CJK 明文', () => {
    for (const name of CIPHERTEXT_FILES) {
      const raw = readFileSync(join(PRESET_DIR, name), 'utf8')
      expect(raw, `${name} 不应包含中文正文`).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/)
      const payload = JSON.parse(raw) as { v: number; alg: string; iv: string; data: string }
      expect(payload.v).toBe(1)
      expect(payload.alg).toBe('AES-256-GCM')
      expect(payload.iv).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(payload.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(payload.data.length).toBeGreaterThan(1_000)
    }
  })

  it('运行时解密出完整正文', () => {
    for (const preset of NO_LIMITS_PRESETS) {
      expect(preset.text.length, `${preset.id} 解密结果为空`).toBeGreaterThan(1_000)
      expect(preset.text).toContain('<project_instructions>')
    }
    // 两个预设的正文不能互相串
    const dshPurge = NO_LIMITS_PRESETS.find((p) => p.id === 'dsh-purge-zh')!
    const keyijiang = NO_LIMITS_PRESETS.find((p) => p.id === 'keyijiang-zh')!
    expect(dshPurge.text).not.toBe(keyijiang.text)
    expect(dshPurge.text.length).not.toBe(keyijiang.text.length)
  })

  it('保留第三方署名与解密参数', () => {
    expect(existsSync(join(PRESET_DIR, 'NOTICE.md'))).toBe(true)
    expect(existsSync(join(PRESET_DIR, 'cipher.meta.json'))).toBe(true)
    expect(existsSync(join(PRESET_DIR, 'cipher.ts'))).toBe(true)
  })
})
