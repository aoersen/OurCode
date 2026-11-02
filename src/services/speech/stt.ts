/**
 * 语音输入（麦克风 → 文字）。
 *
 * ## 为什么不用 Web Speech API
 *
 * 之前那个麦克风按钮走的是 `webkitSpeechRecognition`。Chromium 的这条路径
 * 依赖 Google 的语音服务（需要内建的 GOOGLE_API_KEY），而 Electron 官方
 * 构建根本不带这个 key —— 于是 `rec.start()` 之后立刻抛 `error = 'network'`，
 * 旧的 onerror 只做 `setListening(false)`，用户看到的就是「点了没反应」。
 * 国内网络即使有 key 也连不上，所以这条路在当前项目里是死的，不要再回去。
 *
 * ## 现在的做法
 *
 * 录音（MediaRecorder）→ base64 → 主进程 `net.fetch` → 用户配置的
 * OpenAI 兼容 `/audio/transcriptions` 端点。可选后端：
 *   - 本地 whisper.cpp / faster-whisper 的 server（离线，内网可用）
 *   - 硅基流动 / 阿里 / 腾讯 / OpenAI 等兼容接口
 * API key 只在主进程出现，渲染进程拿不到；主进程也不受 CORS 限制。
 *
 * ## 「接输入法的语音转文字」不在这条链路上
 *
 * 输入法不提供任何可供第三方程序调用的 ASR 接口（讯飞的开放平台是另一套
 * SDK，不是输入法本体）。输入法的语音输入本质是「把识别结果打到当前焦点
 * 控件」—— 也就是用户按输入法自己的语音键说话，文字直接落进输入框。
 * 这条路在 Electron 里是通的（VSCode 同样如此），本项目的输入框也已经做了
 * IME 守卫（`isComposingEvent`），所以它不需要我们「接」，只需要文字能进来。
 * 本模块只负责「点按钮就自动转写」的那部分体验。
 */

/** 用户可配置的 STT 后端。 */
export interface SttConfig {
  /**
   * 'builtin' = 随安装包分发的 whisper.cpp 服务（离线、零配置，走 /inference）；
   * 'endpoint' = 任意 OpenAI 兼容 /audio/transcriptions。
   */
  engine?: 'builtin' | 'endpoint'
  /** OpenAI 兼容的 transcriptions 端点，例如 http://127.0.0.1:8080/v1/audio/transcriptions */
  endpoint: string
  /** Bearer key；本地 server 留空即可。 */
  apiKey: string
  /** 模型名：whisper-1 / whisper-1 兼容名，本地 server 通常随意。 */
  model: string
  /** ISO-639-1，zh / en …；留空让服务端自动判定。 */
  language: string
}

export const DEFAULT_STT_CONFIG: SttConfig = {
  engine: 'endpoint',
  endpoint: '',
  apiKey: '',
  model: 'whisper-1',
  language: 'zh',
}

/** 配置存 localStorage：不进 electron-store，避免和项目设置结构耦合。 */
const STORAGE_KEY = 'ourcode.speech.stt.v1'

/**
 * 安全访问 preload 暴露的桥。测试环境（node）里 `window` 根本不存在 ——
 * 直接 `(window as any).electronAPI` 会抛 ReferenceError，所以先 typeof。
 */
function bridge(): Record<string, any> | null {
  if (typeof window === 'undefined') return null
  return ((window as any).electronAPI ?? null) as Record<string, any> | null
}

export function loadSttConfig(): SttConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<SttConfig>
    return {
      endpoint: String(parsed.endpoint ?? ''),
      apiKey: String(parsed.apiKey ?? ''),
      model: String(parsed.model ?? DEFAULT_STT_CONFIG.model),
      language: String(parsed.language ?? DEFAULT_STT_CONFIG.language),
    }
  } catch {
    return { ...DEFAULT_STT_CONFIG }
  }
}

export function saveSttConfig(cfg: SttConfig): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        endpoint: cfg.endpoint.trim(),
        apiKey: cfg.apiKey.trim(),
        model: cfg.model.trim() || DEFAULT_STT_CONFIG.model,
        language: cfg.language.trim(),
      }),
    )
  } catch { /* ignore quota / private mode */ }
}

/** 只有配了端点才算可用 —— key 和模型都有默认值。 */
export function isSttConfigured(cfg: SttConfig = loadSttConfig()): boolean {
  return cfg.endpoint.trim().length > 0
}

/** 录音能力探测（Electron 里恒为 true；防止测试环境炸）。 */
export function isRecordingSupported(): boolean {
  return typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
}

/** MediaRecorder 的输出格式优先级。Electron 走 Chromium，webm/opus 必得。 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || ''
}

/** 一段录好的音频。保留原始 Blob —— 内置引擎要求 16k WAV，需要现场转码。 */
export interface VoiceRecording {
  blob: Blob
  mime: string
  durationMs: number
}

function bytesToBase64(bytes: Uint8Array): string {
  // 分块拼接：一次性 String.fromCharCode(...bytes) 在长录音上会爆栈。
  const CHUNK = 0x8000
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  // Node（单元测试）环境
  const MaybeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (MaybeBuffer) return MaybeBuffer.from(bytes).toString('base64')
  throw new Error('base64-unsupported')
}

export function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => bytesToBase64(new Uint8Array(buf)))
}

/**
 * 把单声道 float PCM 编成 16bit WAV。
 *
 * whisper.cpp 的 `/inference` 只吃 WAV（要转 webm 得给它装 ffmpeg，我们不打
 * 那么大的依赖），所以在渲染层用 Web Audio 解 webm/opus 再重采样成 16k。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/** 解码任意录音 Blob → 16kHz 单声道 WAV 的 base64。 */
export async function recordingToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  if (typeof window === 'undefined') throw new Error('wav-unsupported')
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
  const AudioCtor = Ctor.AudioContext ?? Ctor.webkitAudioContext
  if (!AudioCtor) throw new Error('wav-unsupported')

  const decodeCtx = new AudioCtor()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    void decodeCtx.close?.()
  }

  const targetRate = 16000
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const offline = new OfflineAudioContext(1, frames, targetRate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return bytesToBase64(encodeWavPcm16(rendered.getChannelData(0), targetRate))
}

/**
 * 麦克风录音器。一次 start/stop 产出一段音频；cancel 丢弃并释放麦克风。
 *
 * 用 class 而不是纯函数，是因为「点一下开始、再点一下结束」需要在两次
 * 点击之间持有 MediaStream / MediaRecorder —— 放进 React state 会被重渲染
 * 拆散，这里由调用方用 ref 持有实例即可。
 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private mime = ''

  async start(): Promise<void> {
    if (this.recorder) return
    if (!isRecordingSupported()) throw new Error('recording-unsupported')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.stream = stream
    this.mime = pickMimeType()
    const recorder = this.mime ? new MediaRecorder(stream, { mimeType: this.mime }) : new MediaRecorder(stream)
    this.chunks = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder = recorder
    this.startedAt = Date.now()
    recorder.start(250) // 每 250ms 出一片，stop 时才不用等太久
  }

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** 停止并返回音频。没有录到任何数据时抛 `empty-recording`。 */
  stop(): Promise<VoiceRecording> {
    const recorder = this.recorder
    if (!recorder) return Promise.reject(new Error('not-recording'))
    const durationMs = Date.now() - this.startedAt
    return new Promise<VoiceRecording>((resolve, reject) => {
      recorder.onstop = async () => {
        const mime = this.mime || recorder.mimeType || 'audio/webm'
        const blob = new Blob(this.chunks, { type: mime })
        this.release()
        if (blob.size === 0) {
          reject(new Error('empty-recording'))
          return
        }
        resolve({ blob, mime: mime.split(';')[0], durationMs })
      }
      recorder.onerror = () => {
        this.release()
        reject(new Error('recording-failed'))
      }
      try {
        recorder.stop()
      } catch (err) {
        this.release()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** 放弃录音（切会话、组件卸载）。幂等。 */
  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    } catch { /* ignore */ }
    this.release()
  }

  /** 关掉麦克风轨道 —— 不关的话系统托盘里的录音指示灯会一直亮。 */
  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
    this.chunks = []
    this.startedAt = 0
  }
}

/** 主进程转写桥的返回结构。 */
export interface TranscribeResult {
  ok: boolean
  text?: string
  error?: string
}

// ───────────────────────── 零配置：端点从哪来 ─────────────────────────

/**
 * 客户不填任何东西也要能说话，所以端点按这个优先级解析：
 *
 *   1. `explicit` —— 用户在语音设置卡里填的（最高优先，永远是逃生口）。
 *   2. `builtin`  —— **随安装包分发的 whisper.cpp**。这是默认路径：不联网、
 *                    不花客户的钱、不依赖任何第三方是否代理音频接口。
 *                    主进程首次用到时懒启动，监听 127.0.0.1 随机端口。
 *   3. `local`    —— 内置引擎没打进包时，探测客户自己起的 whisper.cpp /
 *                    faster-whisper 服务（8080/9000/8123/5001）。
 *   4. `none`     —— 以上都没有，此时才退回「用输入法语音 / Win+H」并说明原因。
 *
 * 刻意不走「拿客户的 LLM key 去调 /audio/transcriptions」那条路 —— 语音不该
 * 和文字模型的账单、代理策略绑在一起。
 */
export type SttSource = 'explicit' | 'builtin' | 'local' | 'none'

/** 本地 whisper 服务的常见端口（whisper.cpp server / faster-whisper / asr-webservice）。 */
const LOCAL_STT_PORTS = [8080, 9000, 8123, 5001]

/** 本地 whisper 服务探测结果缓存（同一个会话内不重复打） */
let localProbeResult: SttConfig | null | undefined

/** 单元测试用：清空探测缓存，避免用例之间互相污染。 */
export function __resetLocalProbeCache(): void {
  localProbeResult = undefined
}

/** 探测本地 whisper 服务。没有 electronAPI（测试环境）时直接返回 null。 */
export async function probeLocalStt(force = false): Promise<SttConfig | null> {
  if (!force && localProbeResult !== undefined) return localProbeResult
  const api = bridge()
  if (!api?.speechProbe) {
    localProbeResult = null
    return null
  }
  const candidates = LOCAL_STT_PORTS.map((port) => `http://127.0.0.1:${port}/v1/audio/transcriptions`)
  try {
    const hits: string[] = await api.speechProbe(candidates)
    localProbeResult = hits && hits.length > 0
      ? { endpoint: hits[0], apiKey: '', model: 'whisper-1', language: 'zh' }
      : null
  } catch {
    localProbeResult = null
  }
  return localProbeResult
}

/** 内置引擎（随安装包分发的 whisper.cpp）状态。 */
export interface BuiltinEngineStatus {
  available: boolean
  running: boolean
  model: string | null
  port: number | null
  error: string | null
}

let builtinStatusCache: BuiltinEngineStatus | null | undefined

/** 单元测试用：清空内置引擎状态缓存。 */
export function __resetBuiltinStatusCache(): void {
  builtinStatusCache = undefined
}

/**
 * 问主进程「内置引擎在不在」。只读文件系统，不拉起进程 —— 所以可以放心
 * 在点击前调用。
 */
export async function getBuiltinEngineStatus(force = false): Promise<BuiltinEngineStatus | null> {
  if (!force && builtinStatusCache !== undefined) return builtinStatusCache
  const api = bridge()
  if (!api?.speechEngine) {
    builtinStatusCache = null
    return null
  }
  try {
    builtinStatusCache = (await api.speechEngine()) as BuiltinEngineStatus
  } catch {
    builtinStatusCache = null
  }
  return builtinStatusCache
}

/** 解析出一份可用的 STT 配置（含来源，用来在 UI 里说明「为什么现在能用」）。 */
export async function resolveSttConfig(
  explicit: SttConfig = loadSttConfig(),
): Promise<{ config: SttConfig; source: SttSource }> {
  if (isSttConfigured(explicit)) return { config: explicit, source: 'explicit' }

  // 内置引擎优先：离线、随包自带、不依赖任何第三方是否代理音频接口。
  const builtin = await getBuiltinEngineStatus()
  if (builtin?.available) {
    return {
      config: {
        ...DEFAULT_STT_CONFIG,
        engine: 'builtin',
        model: builtin.model || 'whisper',
        language: explicit.language || 'zh',
      },
      source: 'builtin',
    }
  }

  const local = await probeLocalStt()
  if (local) return { config: local, source: 'local' }
  return { config: explicit, source: 'none' }
}

/**
 * 把录好的音频交给主进程转写。失败一律抛错，由调用方转成用户可见提示。
 *
 * 内置引擎只吃 16k WAV，所以这条分支先在渲染层解码/重采样；云端端点收
 * 原始 webm（体积小得多，也省一次 CPU 转码）。
 */
export async function transcribeRecording(
  recording: VoiceRecording,
  cfg: SttConfig = loadSttConfig(),
): Promise<string> {
  const api = bridge()
  if (!api?.speechTranscribe) throw new Error('speech-bridge-missing')

  const useBuiltin = cfg.engine === 'builtin'
  if (!useBuiltin && !cfg.endpoint.trim()) throw new Error('stt-not-configured')

  let audioBase64: string
  let mime: string
  if (useBuiltin) {
    audioBase64 = await recordingToWavBase64(recording.blob)
    mime = 'audio/wav'
  } else {
    audioBase64 = await blobToBase64(recording.blob)
    mime = recording.mime || 'audio/webm'
  }

  const result: TranscribeResult | undefined = await api.speechTranscribe({
    engine: useBuiltin ? 'builtin' : 'endpoint',
    endpoint: useBuiltin ? '' : cfg.endpoint.trim(),
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim() || DEFAULT_STT_CONFIG.model,
    language: cfg.language.trim(),
    audioBase64,
    mime,
  })
  if (!result?.ok) throw new Error(result?.error || 'transcription-failed')
  const text = (result.text || '').trim()
  if (!text) throw new Error('empty-transcript')
  return text
}
