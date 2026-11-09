#!/usr/bin/env node
/**
 * no-limits 提示词预设的加密 / 解密 CLI。
 *
 * 仓库里只提交 `<id>.enc.json`（AES-256-GCM 密文），不提交 `.zh.md` 明文；
 * 应用在模块加载时才解密到内存。维护流程：
 *
 *   npm run presets:decode     # 本地解出明文 *.zh.md 供编辑
 *   （编辑 src/services/noLimits/presets/*.zh.md）
 *   npm run presets:encode     # 重新加密，成功后删除本地明文
 *   npm run presets:check      # CI / prebuild 守卫：无明文、密文可解密
 *
 * 注意：密钥随仓库分发（cipher.meta.json），这层加密只用于避免提示词正文
 * 被 git / code search 直接命中，不是对运行本仓库的人保密。
 *
 * 与 src/services/noLimits/presets/cipher.ts 的 KDF / AAD / 密文布局必须一致。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_DIR = join(ROOT, 'src', 'services', 'noLimits', 'presets')
const META_PATH = join(PRESET_DIR, 'cipher.meta.json')

const PRESETS = [
  { id: 'dsh-purge-zh', base: 'dsh-purge.zh' },
  { id: 'keyijiang-zh', base: 'keyijiang.zh' },
]

const meta = JSON.parse(await readFile(META_PATH, 'utf8'))
if (meta.v !== 1 || meta.alg !== 'AES-256-GCM') {
  throw new Error(`unsupported cipher metadata: ${META_PATH}`)
}

const KEY = createHash('sha256').update(meta.keyMaterial, 'utf8').digest()
const AAD = Buffer.from(meta.aad, 'utf8')

const plainPath = (preset) => join(PRESET_DIR, `${preset.base}.md`)
const payloadPath = (preset) => join(PRESET_DIR, `${preset.base}.enc.json`)

function encrypt(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(meta.alg, KEY, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: meta.v,
    alg: meta.alg,
    iv: iv.toString('base64'),
    // WebCrypto 的 AES-GCM 约定：认证标签拼在密文尾部（16 字节）。
    data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64'),
  }
}

function decrypt(payload) {
  if (!payload || payload.v !== meta.v || payload.alg !== meta.alg) {
    throw new Error('unsupported payload header')
  }
  const iv = Buffer.from(payload.iv, 'base64')
  const data = Buffer.from(payload.data, 'base64')
  if (iv.length !== 12) throw new Error(`bad iv length: ${iv.length}`)
  if (data.length <= 16) throw new Error('ciphertext too short')
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(0, data.length - 16)
  const decipher = createDecipheriv(meta.alg, KEY, iv)
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function encode({ keepPlaintext = false } = {}) {
  let encoded = 0
  for (const preset of PRESETS) {
    const source = plainPath(preset)
    if (!existsSync(source)) {
      console.log(`· skip ${preset.base}.md (not present)`)
      continue
    }
    const plaintext = await readFile(source, 'utf8')
    if (!plaintext.trim()) throw new Error(`${preset.base}.md is empty`)
    const payload = encrypt(plaintext)
    if (decrypt(payload) !== plaintext) {
      throw new Error(`round-trip mismatch for ${preset.id}; refusing to write`)
    }
    await writeFile(payloadPath(preset), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    encoded += 1
    console.log(`✓ ${preset.base}.md -> ${preset.base}.enc.json (${plaintext.length} chars)`)
    if (!keepPlaintext) {
      await unlink(source)
      console.log(`  removed local plaintext ${preset.base}.md`)
    }
  }
  if (encoded === 0) {
    console.error('✗ nothing encoded; run `npm run presets:decode` first if you need to edit a preset')
    process.exitCode = 1
  }
}

async function decode() {
  for (const preset of PRESETS) {
    const source = payloadPath(preset)
    const payload = JSON.parse(await readFile(source, 'utf8'))
    const plaintext = decrypt(payload)
    await writeFile(plainPath(preset), plaintext, 'utf8')
    console.log(`✓ ${preset.base}.enc.json -> ${preset.base}.md (${plaintext.length} chars)`)
  }
  console.log('！明文已解出到本地；编辑完请运行 `npm run presets:encode`（会重新加密并删除明文）')
}

async function check() {
  const problems = []
  // 任何 `.md` 都可能是明文预设；只放行署名与维护说明。
  const allowedMarkdown = new Set(['NOTICE.md', 'README.md'])
  for (const name of await readdir(PRESET_DIR)) {
    if (name.endsWith('.md') && !allowedMarkdown.has(name)) {
      problems.push(`${name} exists — plaintext presets must not be committed (run: npm run presets:encode)`)
    }
  }
  for (const preset of PRESETS) {
    const target = payloadPath(preset)
    if (!existsSync(target)) {
      problems.push(`${preset.base}.enc.json is missing`)
      continue
    }
    try {
      const raw = JSON.parse(await readFile(target, 'utf8'))
      const plaintext = decrypt(raw)
      if (plaintext.trim().length < 1_000) {
        problems.push(`${preset.base}.enc.json decrypted to only ${plaintext.trim().length} chars`)
      }
    } catch (err) {
      problems.push(`${preset.base}.enc.json cannot be decrypted: ${err.message}`)
    }
  }
  if (!existsSync(join(PRESET_DIR, 'NOTICE.md'))) {
    problems.push('NOTICE.md is missing — third-party attribution must stay in the repo')
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${PRESETS.length} encrypted presets OK; no plaintext .md present`)
}

const command = process.argv[2] ?? ''
if (command === 'encode') {
  await encode({ keepPlaintext: process.argv.includes('--keep') })
} else if (command === 'decode') {
  await decode()
} else if (command === 'check') {
  await check()
} else {
  console.error('usage: node scripts/prompt-presets.mjs <encode|decode|check> [--keep]')
  process.exitCode = 2
}
