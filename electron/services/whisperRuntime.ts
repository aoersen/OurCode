/**
 * 内置 whisper 引擎（whisper.cpp server）。
 *
 * 目的：客户**什么都不配**也能点麦克风说话。打包时把
 * `resources/whisper/bin/whisper-server.exe`（+ 同目录 DLL）和
 * `resources/whisper/models/ggml-*.bin` 塞进安装包，首次用到语音时懒启动一个
 * 只监听 127.0.0.1 的本地进程，用完随应用退出。
 *
 * 为什么不直接让渲染进程 fetch：whisper.cpp 的 server 不发 CORS 头，而且
 * 端口是运行时分配的。所以这里负责三件事 —— 找端口、拉起进程、健康检查。
 *
 * 模型选择优先级：
 *   userData/whisper/models（客户想换更大模型就丢这儿）
 *   > resources/whisper/models（内置）
 *   > 名字优先 small > base > medium > 其它
 */

import { app, net } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { createServer } from 'net'
import { cpus } from 'os'
import { join } from 'path'

/** 启动完成后对外的句柄。 */
export interface WhisperRuntime {
  /** http://127.0.0.1:PORT */
  baseUrl: string
  /** whisper.cpp 的推理端点（默认 /inference） */
  inferenceUrl: string
  port: number
  /** 正在使用的模型文件名 */
  model: string
}

/** 打包后资源根：<app>/resources/whisper；开发时：<repo>/resources/whisper。 */
function resourceRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

function serverBinary(): string | null {
  const name = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
  const direct = join(resourceRoot(), 'bin', name)
  if (existsSync(direct)) return direct
  // 非 Windows 的 release 产物解压后可能不套 bin/ 目录
  const flat = join(resourceRoot(), name)
  return existsSync(flat) ? flat : null
}

/** 内置模型文件名优先级：中文场景 small 明显好于 base，medium 太吃内存。 */
const MODEL_ORDER = [
  'ggml-small-q8_0.bin',
  'ggml-small.bin',
  'ggml-base-q8_0.bin',
  'ggml-base.bin',
  'ggml-medium-q8_0.bin',
  'ggml-medium.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-tiny-q8_0.bin',
  'ggml-tiny.bin',
]

/**
 * 模型文件最小体积（字节）。最小的 tiny-q8_0 也有 ~41MB，所以 10MB 以下的
 * 一定是下载中断留下的半截文件 —— 选它会启动失败，不如直接跳过。
 */
const MIN_MODEL_BYTES = 10 * 1024 * 1024

/** 找模型：用户目录优先，其次内置；同名优先 MODEL_ORDER。 */
export function pickWhisperModel(): string | null {
  const dirs = [
    join(app.getPath('userData'), 'whisper', 'models'),
    join(resourceRoot(), 'models'),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const bins = readdirSync(dir).filter((f) => {
      if (!f.toLowerCase().endsWith('.bin')) return false
      try {
        return statSync(join(dir, f)).size >= MIN_MODEL_BYTES
      } catch {
        return false
      }
    })
    if (bins.length === 0) continue
    const ordered = MODEL_ORDER.map((name) => bins.find((b) => b === name)).filter(
      (b): b is string => !!b,
    )
    const chosen = ordered[0] ?? bins.sort()[0]
    return join(dir, chosen)
  }
  return null
}

/** 找一条空闲端口（只 bind 127.0.0.1，不对外暴露）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no-port'))))
    })
  })
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等 server 起来：任何 <500 的响应（含 404）都证明进程在听。 */
async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await net.fetch(`http://127.0.0.1:${port}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      })
      if (res.status < 500) return true
    } catch { /* 还没监听 */ }
    await delay(200)
  }
  return false
}

let child: ChildProcess | null = null
let runtime: WhisperRuntime | null = null
let starting: Promise<WhisperRuntime | null> | null = null
/** 上次启动失败的原因 —— UI 拿它解释「为什么内置引擎没生效」。 */
let lastError: string | null = null
/** 启动时留着的 stderr 尾巴，崩溃时拼进错误信息。 */
let stderrTail: string[] = []

function pushStderr(chunk: Buffer): void {
  stderrTail.push(chunk.toString('utf-8'))
  if (stderrTail.length > 20) stderrTail.shift()
}

async function startServer(): Promise<WhisperRuntime | null> {
  const bin = serverBinary()
  const model = pickWhisperModel()
  if (!bin || !model) {
    lastError = bin ? '未找到内置 whisper 模型（resources/whisper/models）' : '未找到内置 whisper-server'
    return null
  }

  const port = await freePort()
  const threads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))
  const args = [
    '-m', model,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(threads),
    // 语言交给请求参数决定；默认 auto 免得中文被按英文解码
    '-l', 'auto',
    // 输出纯文本，避免 [00:00:00.000 --> ...] 混进输入框
    '-nt',
    '--no-gpu',
  ]

  stderrTail = []
  const proc = spawn(bin, args, {
    cwd: join(bin, '..'),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr?.on('data', pushStderr)
  proc.on('error', (err) => {
    lastError = `内置 whisper 启动失败: ${err.message}`
  })
  proc.on('exit', (code) => {
    // 非主动 kill：把进程状态清干净，下次点击会重新拉起
    if (child === proc) {
      child = null
      runtime = null
      if (code !== 0 && code !== null) {
        lastError = `内置 whisper 退出 (code ${code}): ${stderrTail.slice(-3).join(' ').slice(0, 300)}`
      }
    }
  })

  const ready = await waitForServer(port, 30_000)
  if (!ready) {
    lastError = `内置 whisper 启动超时: ${stderrTail.slice(-3).join(' ').slice(0, 300)}`
    try { proc.kill() } catch { /* ignore */ }
    if (child === proc) child = null
    return null
  }

  child = proc
  lastError = null
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    inferenceUrl: `http://127.0.0.1:${port}/inference`,
    port,
    model: model.split(/[\\/]/).pop() || model,
  }
}

/**
 * 懒启动 + 单飞：并发的多次点击只会拉起一个进程。
 * 返回 null 表示这台机器上内置引擎不可用（没打到包 / 缺模型 / 启动失败）。
 */
export async function ensureWhisperServer(): Promise<WhisperRuntime | null> {
  if (runtime) return runtime
  if (starting) return starting
  starting = (async () => {
    try {
      const rt = await startServer()
      runtime = rt
      return rt
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      starting = null
    }
  })()
  return starting
}

/** 应用退出时收尾 —— 不留孤儿进程占着 CPU。 */
export function stopWhisperServer(): void {
  runtime = null
  const proc = child
  child = null
  if (!proc) return
  try {
    // Windows 上 SIGTERM 不会真的杀进程，直接用 taskkill 兜一层
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' })
    } else {
      proc.kill()
    }
  } catch { /* ignore */ }
}

/** 给 UI/诊断用的状态。 */
export function whisperStatus(): {
  available: boolean
  running: boolean
  model: string | null
  port: number | null
  error: string | null
} {
  return {
    available: !!serverBinary() && !!pickWhisperModel(),
    running: !!runtime,
    model: runtime?.model ?? pickWhisperModel()?.split(/[\\/]/).pop() ?? null,
    port: runtime?.port ?? null,
    error: lastError,
  }
}
