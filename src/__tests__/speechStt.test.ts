import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_STT_CONFIG,
  __resetBuiltinStatusCache,
  __resetLocalProbeCache,
  encodeWavPcm16,
  getBuiltinEngineStatus,
  isSttConfigured,
  loadSttConfig,
  probeLocalStt,
  resolveSttConfig,
  saveSttConfig,
  transcribeRecording,
} from '@/services/speech/stt'

/** localStorage 在 node 环境里只是 vi.stubGlobal 的空壳，这里给一个真能存的内存版。 */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
}

const recording = {
  blob: new Blob([new Uint8Array([0, 0, 0])], { type: 'audio/webm' }),
  mime: 'audio/webm',
  durationMs: 1200,
}

describe('stt config', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()) })

  it('falls back to the defaults when nothing is stored', () => {
    expect(loadSttConfig()).toEqual(DEFAULT_STT_CONFIG)
    expect(isSttConfigured()).toBe(false)
  })

  it('round-trips a saved config and trims whitespace', () => {
    saveSttConfig({ endpoint: '  http://127.0.0.1:8080/v1/audio/transcriptions ', apiKey: ' k ', model: '', language: ' zh ' })
    const cfg = loadSttConfig()
    expect(cfg.endpoint).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
    expect(cfg.apiKey).toBe('k')
    // 空模型名回退到默认值，否则请求体里 model='' 会被服务端拒
    expect(cfg.model).toBe(DEFAULT_STT_CONFIG.model)
    expect(cfg.language).toBe('zh')
    expect(isSttConfigured(cfg)).toBe(true)
  })

  it('survives a corrupted stored value', () => {
    localStorage.setItem('ourcode.speech.stt.v1', '{not json')
    expect(loadSttConfig()).toEqual(DEFAULT_STT_CONFIG)
  })
})


describe('resolveSttConfig precedence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    __resetLocalProbeCache()
    __resetBuiltinStatusCache()
  })

  it('prefers the explicitly configured endpoint', async () => {
    const explicit = { endpoint: 'https://mine.example.com/v1/audio/transcriptions', apiKey: 'a', model: 'whisper-1', language: 'zh' }
    const { config, source } = await resolveSttConfig(explicit)
    expect(source).toBe('explicit')
    expect(config).toEqual(explicit)
  })

  it('uses the bundled engine before asking the customer for anything', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        speechEngine: vi.fn().mockResolvedValue({
          available: true, running: false, model: 'ggml-small-q8_0.bin', port: null, error: null,
        }),
      },
    })
    const { config, source } = await resolveSttConfig({ ...DEFAULT_STT_CONFIG })
    expect(source).toBe('builtin')
    expect(config.engine).toBe('builtin')
    expect(config.model).toBe('ggml-small-q8_0.bin')
  })

  it('falls back to a local server when the pack has no binary/model', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        speechEngine: vi.fn().mockResolvedValue({
          available: false, running: false, model: null, port: null, error: '未找到内置 whisper-server',
        }),
        speechProbe: vi.fn().mockResolvedValue([]),
      },
    })
    const { source } = await resolveSttConfig({ ...DEFAULT_STT_CONFIG })
    expect(source).toBe('none')
  })

  it('falls back to a local whisper server when nothing is bundled', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        speechProbe: vi.fn().mockResolvedValue(['http://127.0.0.1:8080/v1/audio/transcriptions']),
        speechEngine: vi.fn().mockResolvedValue({ available: false, running: false, model: null, port: null, error: null }),
      },
    })
    const { config, source } = await resolveSttConfig({ ...DEFAULT_STT_CONFIG })
    expect(source).toBe('local')
    expect(config.endpoint).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
  })

  it('caches the probe so repeated clicks do not re-scan ports', async () => {
    const speechProbe = vi.fn().mockResolvedValue([])
    vi.stubGlobal('window', { electronAPI: { speechProbe } })
    await probeLocalStt()
    await probeLocalStt()
    expect(speechProbe).toHaveBeenCalledTimes(1)
  })

  it('reports none when nothing is available', async () => {
    vi.stubGlobal('window', { electronAPI: { speechProbe: vi.fn().mockResolvedValue([]) } })
    const { source } = await resolveSttConfig({ ...DEFAULT_STT_CONFIG })
    expect(source).toBe('none')
  })
})

describe('getBuiltinEngineStatus', () => {
  beforeEach(() => { __resetBuiltinStatusCache() })

  it('returns null when the preload bridge is absent', async () => {
    vi.stubGlobal('window', {})
    await expect(getBuiltinEngineStatus()).resolves.toBeNull()
  })

  it('reads the status from the main process once and caches it', async () => {
    const speechEngine = vi.fn().mockResolvedValue({
      available: true, running: false, model: 'ggml-small-q8_0.bin', port: null, error: null,
    })
    vi.stubGlobal('window', { electronAPI: { speechEngine } })
    const first = await getBuiltinEngineStatus()
    const second = await getBuiltinEngineStatus()
    expect(first?.available).toBe(true)
    expect(second).toEqual(first)
    expect(speechEngine).toHaveBeenCalledTimes(1)
  })
})

describe('encodeWavPcm16', () => {
  it('writes a valid 16kHz mono PCM header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const bytes = encodeWavPcm16(samples, 16000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const ascii = (offset: number, len: number) =>
      String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16) // bit depth
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
    expect(bytes.byteLength).toBe(44 + samples.length * 2)
  })

  it('clips out-of-range samples instead of wrapping them', () => {
    const bytes = encodeWavPcm16(new Float32Array([2, -2]), 16000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })
})

describe('transcribeRecording', () => {
  const cfg = { endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions', apiKey: '', model: 'whisper-1', language: 'zh' }

  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()) })

  it('rejects when no endpoint is configured', async () => {
    vi.stubGlobal('window', { electronAPI: { speechTranscribe: vi.fn() } })
    await expect(transcribeRecording(recording, { ...cfg, endpoint: '' })).rejects.toThrow('stt-not-configured')
  })

  it('rejects when the preload bridge is missing (stale preload)', async () => {
    vi.stubGlobal('window', {})
    await expect(transcribeRecording(recording, cfg)).rejects.toThrow('speech-bridge-missing')
  })

  it('returns the transcript and forwards the audio unchanged', async () => {
    const speechTranscribe = vi.fn().mockResolvedValue({ ok: true, text: ' 你好世界 ' })
    vi.stubGlobal('window', { electronAPI: { speechTranscribe } })

    await expect(transcribeRecording(recording, cfg)).resolves.toBe('你好世界')
    expect(speechTranscribe).toHaveBeenCalledWith({
      engine: 'endpoint',
      endpoint: cfg.endpoint,
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
      audioBase64: 'AAAA',
      mime: 'audio/webm',
    })
  })

  it('surfaces the main-process error message', async () => {
    vi.stubGlobal('window', { electronAPI: { speechTranscribe: vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 401' }) } })
    await expect(transcribeRecording(recording, cfg)).rejects.toThrow('HTTP 401')
  })

  it('treats an empty transcript as a failure', async () => {
    vi.stubGlobal('window', { electronAPI: { speechTranscribe: vi.fn().mockResolvedValue({ ok: true, text: '   ' }) } })
    await expect(transcribeRecording(recording, cfg)).rejects.toThrow('empty-transcript')
  })
})
