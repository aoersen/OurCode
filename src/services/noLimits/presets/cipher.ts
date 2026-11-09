import cipherMeta from './cipher.meta.json'

/**
 * 内置提示词预设的静态加密（AES-256-GCM）。
 *
 * 仓库里只提交 `<id>.enc.json` 密文，正文在模块加载时才解密到内存，
 * 这样 git / GitHub code search 搜不到提示词正文。**这不是密码学意义上的
 * 保密**：密钥（cipher.meta.json 的 keyMaterial）随应用一起分发，能运行
 * 本应用的人最终都能还原正文。它要挡住的是「随手上 GitHub 搜一句提示词
 * 就抄走」这类场景，不是有备而来的逆向。
 *
 * 编码/解码在 scripts/prompt-presets.mjs，两边的 KDF / AAD / 密文布局必须
 * 保持一致（该脚本的 `check` 与单测会验证）。
 */

export interface EncryptedPresetPayload {
  v: number
  alg: string
  iv: string
  data: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 每次加载只派生一次密钥；两个预设共用。 */
let keyPromise: Promise<CryptoKey> | null = null

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const raw = await crypto.subtle.digest('SHA-256', encoder.encode(cipherMeta.keyMaterial))
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    })()
  }
  return keyPromise
}

/**
 * 解密一个预设载荷。失败时返回空串并打日志：预设正文是可选能力，
 * 不应该因为一个损坏的资源文件把整个应用启动打断。
 */
export async function decryptPresetText(
  payload: EncryptedPresetPayload,
  presetId: string,
): Promise<string> {
  try {
    if (payload?.v !== cipherMeta.v || payload?.alg !== cipherMeta.alg) {
      throw new Error(`unsupported payload header (v=${String(payload?.v)}, alg=${String(payload?.alg)})`)
    }
    const key = await getKey()
    const plain = await crypto.subtle.decrypt(
      {
        // WebCrypto 的算法名是 'AES-GCM'；'AES-256-GCM' 只是载荷里的标识（密钥长度由 256-bit key 决定）。
        name: 'AES-GCM',
        iv: base64ToBytes(payload.iv),
        additionalData: encoder.encode(cipherMeta.aad),
      },
      key,
      base64ToBytes(payload.data),
    )
    return decoder.decode(plain)
  } catch (err) {
    console.error(`[noLimits] failed to decrypt preset "${presetId}":`, err)
    return ''
  }
}
