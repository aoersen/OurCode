#!/usr/bin/env node
/**
 * 拉取「随安装包分发」的 whisper.cpp 二进制与模型。
 *
 *   node scripts/fetch-whisper.mjs                  # 默认 small（中文效果好）
 *   node scripts/fetch-whisper.mjs --model base     # 小一点，82MB
 *   node scripts/fetch-whisper.mjs --if-missing     # 构建前调用：已有就跳过，失败只警告
 *   node scripts/fetch-whisper.mjs --force          # 重新下载
 *   node scripts/fetch-whisper.mjs --proxy http://127.0.0.1:7897
 *
 * 产物（被打进 electron-builder 的 extraResources）：
 *   resources/whisper/bin/whisper-server.exe + whisper.dll + ggml*.dll + SDL2.dll
 *   resources/whisper/models/ggml-<model>-q8_0.bin
 *
 * 二进制与模型都不进 git（体积太大），所以 clone 后第一次打包需要跑一次本脚本
 * —— `prebuild` 已经挂了 `--if-missing`，正常打包不用手动执行。
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'resources', 'whisper')
const BIN_DIR = join(DEST, 'bin')
const MODEL_DIR = join(DEST, 'models')

/** whisper.cpp 的 CI 构建（带 whisper-server.exe）。tag 对应 ggml-org/whisper.cpp。 */
const WHISPER_TAG = 'b5454'
const BINARY_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`

/** 只带 whisper-server 真正需要的文件：主程序 + 三个核心 dll + CPU 派发 dll + SDL2。 */
const NEEDED = new Set(['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'SDL2.dll'])

const MODELS = {
  tiny: { file: 'ggml-tiny-q8_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q8_0.bin', mb: 43 },
  base: { file: 'ggml-base-q8_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin', mb: 82 },
  small: { file: 'ggml-small-q8_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin', mb: 253 },
  medium: { file: 'ggml-medium-q8_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q8_0.bin', mb: 800 },
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const ifMissing = flag('if-missing')
const force = flag('force')
const modelKey = value('model', 'small')
const proxy = value('proxy', process.env.HTTPS_PROXY || process.env.https_proxy || '')

const log = (...m) => console.log('[whisper]', ...m)
const warn = (...m) => console.warn('[whisper]', ...m)

function bail(message, code = 1) {
  if (ifMissing) {
    warn(message)
    warn('跳过模型下载，沿用 resources/whisper 里已有的模型（没有则语音退回本机服务探测 / 输入法语音）')
    process.exit(0)
  }
  console.error('[whisper]', message)
  process.exit(code)
}

/** 有 curl 就用 curl（自带重定向与代理支持），否则退回 node fetch。 */
function download(url, dest) {
  const curlArgs = ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '-o', dest, url]
  if (proxy) curlArgs.splice(0, 0, '--proxy', proxy)
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const curl = spawnSync(bin, ['--version'], { stdio: 'ignore' })
  if (curl.status === 0) {
    log(`curl → ${dest}`)
    const res = spawnSync(bin, ['-sS', ...curlArgs], { stdio: 'inherit' })
    if (res.status !== 0) throw new Error(`curl 下载失败 (${res.status}): ${url}`)
    return Promise.resolve()
  }

  log(`fetch → ${dest}`)
  return fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ourcode-build' } }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    const total = Number(res.headers.get('content-length') || 0)
    let done = 0
    let lastPct = -1
    const out = createWriteStream(dest)
    const reader = res.body.getReader()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      out.write(Buffer.from(value))
      done += value.length
      if (total) {
        const pct = Math.floor((done / total) * 100)
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct
          log(`${pct}% (${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`)
        }
      }
    }
    await new Promise((r) => out.end(r))
  })
}

/** 用 PowerShell 自带的能力解 zip（避免给仓库加解压依赖）。 */
function extractZip(zipPath, targetDir) {
  const ps = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
    foreach ($e in $zip.Entries) {
      $name = Split-Path $e.FullName -Leaf
      if ($e.FullName -notlike 'Release/*') { continue }
      if (($name -eq 'whisper-server.exe') -or ($name -eq 'whisper.dll') -or ($name -eq 'ggml.dll') -or
          ($name -eq 'ggml-base.dll') -or ($name -eq 'SDL2.dll') -or ($name -like 'ggml-cpu-*.dll')) {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path '${targetDir.replace(/'/g, "''")}' $name), $true)
      }
    }
    $zip.Dispose()
  `
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('解压失败（需要 PowerShell + .NET Framework）')
}

async function fetchBinary() {
  mkdirSync(BIN_DIR, { recursive: true })
  const hasServer = existsSync(join(BIN_DIR, 'whisper-server.exe'))
  const hasCpuDll = existsSync(BIN_DIR)
    ? readdirSync(BIN_DIR).some((f) => f.startsWith('ggml-cpu-'))
    : false
  if (hasServer && hasCpuDll && !force) {
    log('二进制已存在，跳过')
    return
  }
  if (process.platform !== 'win32') {
    bail('内置二进制目前只提供 Windows x64 版本；macOS/Linux 请自行放置 whisper-server 到 resources/whisper/bin/')
  }

  const zip = join(DEST, '.whisper-bin.zip')
  await download(BINARY_URL, zip)
  log('解压需要的文件…')
  extractZip(zip, BIN_DIR)
  try { unlinkSync(zip) } catch { /* ignore */ }

  for (const name of NEEDED) {
    if (!existsSync(join(BIN_DIR, name))) bail(`解压后缺少 ${name}`)
  }
  log(`二进制就绪（${readdirSync(BIN_DIR).length} 个文件）`)
}

async function fetchModel() {
  const spec = MODELS[modelKey]
  if (!spec) bail(`未知模型: ${modelKey}（可选 ${Object.keys(MODELS).join(' / ')}）`)
  mkdirSync(MODEL_DIR, { recursive: true })

  // 构建期（--if-missing）：只要目录里已经有一个像样的模型就够打包了，
  // 不去追默认的 small —— 否则没网时每次 prebuild 都白等一次超时。
  if (ifMissing && !force) {
    const usable = readdirSync(MODEL_DIR).filter((f) => {
      if (!f.toLowerCase().endsWith('.bin')) return false
      try {
        return statSync(join(MODEL_DIR, f)).size >= 10 * 1024 * 1024
      } catch {
        return false
      }
    })
    if (usable.length > 0) {
      log(`已有可用模型（${usable.join(', ')}），跳过`);
      return
    }
  }

  const dest = join(MODEL_DIR, spec.file)
  if (existsSync(dest) && !force) {
    const mb = statSync(dest).size / 1048576
    // HF 的 q8_0 体积是固定的；明显偏小说明上次断在半路
    if (mb > spec.mb * 0.9) {
      log(`模型已存在（${mb.toFixed(0)}MB），跳过`)
      return
    }
    warn(`模型文件不完整（${mb.toFixed(1)}MB / 约 ${spec.mb}MB），重新下载`)
    try { unlinkSync(dest) } catch { /* ignore */ }
  }

  const tmp = `${dest}.part`
  await download(spec.url, tmp)
  renameSync(tmp, dest)
  log(`模型就绪: ${spec.file} (${(statSync(dest).size / 1048576).toFixed(1)}MB)`)
}

try {
  await fetchBinary()
  await fetchModel()
  log(`完成 → ${DEST}`)
} catch (error) {
  bail(error instanceof Error ? error.message : String(error))
}
