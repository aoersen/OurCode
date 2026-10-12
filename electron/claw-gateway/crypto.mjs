/**
 * Claw 网关的协议加密工具（纯函数，可离线单测）。
 *
 * 三段代码分别对应三个平台的公开加密规范：
 *  - 企业微信 / 微信公众平台回调：AES-256-CBC + PKCS7（**块长 32**），
 *    key = base64(EncodingAESKey + "=")，iv = key 前 16 字节；明文结构为
 *    「16 字节随机 + 4 字节大端长度 + 消息体 + receiveid」；
 *  - 飞书事件回调：key = sha256(encryptKey) 的原始字节，密文为
 *    base64(iv[16] + ciphertext)，PKCS7 块长 16；
 *  - QQ 机器人回调：Ed25519。平台要求用「私钥种子」对 event_ts+plain_token
 *    签名完成回调地址校验，并用平台公钥校验入站请求签名（X-Signature-Ed25519
 *    对 timestamp + body 的签名）。
 *
 * 这里只做数学，不做协议状态机——协议在各自 adapters/ 里。
 */
import { createPrivateKey, createPublicKey, createHash, createDecipheriv, createCipheriv, randomBytes, sign, verify } from 'node:crypto'

/** Ed25519 裸公钥 → SPKI DER 前缀（RFC 8410）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** Ed25519 32 字节种子 → PKCS8 DER 前缀（RFC 8410）。 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** PKCS7 去填充（块长可配：微信系用 32，标准用 16）。填充不合法即抛错。 */
export function stripPkcs7(buf, blockSize = 32) {
  if (buf.length === 0) throw new Error('密文长度为 0')
  const pad = buf[buf.length - 1]
  if (pad < 1 || pad > blockSize || pad > buf.length) {
    // 填充字节非法 = 密文被改动或密钥不对。不能「原样返回」——那等于把篡改
    // 当成正常内容交给上层（签名只保证来源，不能替代这里的一致性检查）。
    throw new Error(`PKCS7 填充非法（pad=${pad}）：密文损坏或密钥不匹配`)
  }
  return buf.subarray(0, buf.length - pad)
}

/** PKCS7 填充（块长可配；整块对齐时补满一整块）。 */
export function addPkcs7(buf, blockSize = 32) {
  const pad = blockSize - (buf.length % blockSize) || blockSize
  return Buffer.concat([buf, Buffer.alloc(pad, pad)])
}

/** sha1 签名校验（微信/企业微信）：token、timestamp、nonce、密文排序后拼接取 sha1。 */
export function wechatSignature(parts) {
  const sorted = [...parts].map((p) => String(p ?? '')).sort()
  return createHash('sha1').update(sorted.join('')).digest('hex')
}

/** 常量时间比较（避免签名比较的时序侧信道）。 */
export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

// ── 企业微信 / 微信公众平台 ────────────────────────────────────────────────

/** EncodingAESKey（43 位）+ receiveid 校验 → 解密后的消息体（utf8）。 */
export function decryptWechatAes({ encodingAesKey, encrypt, receiveId }) {
  const key = Buffer.from(String(encodingAesKey ?? '') + '=', 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey 非法（需要 43 位 base64）')
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const plain = stripPkcs7(Buffer.concat([decipher.update(Buffer.from(String(encrypt ?? ''), 'base64')), decipher.final()]), 32)
  if (plain.length < 20) throw new Error('解密结果过短')
  const msgLen = plain.readUInt32BE(16)
  if (msgLen < 0 || 20 + msgLen > plain.length) {
    // 长度字段越界 = 密文被改动（长度字段本身也参与 AES 的完整性，越界说明
    // 解密结果不可信）。绝不用 slice 的静默截断掩盖它。
    throw new Error(`消息长度字段越界（msgLen=${msgLen}, 可用=${plain.length - 20}）`)
  }
  const msg = plain.subarray(20, 20 + msgLen)
  const tail = plain.subarray(20 + msgLen).toString('utf8')
  // receiveid 必须与配置一致（企业微信 = corpid，公众号 = appid）；未配置时跳过。
  if (receiveId && tail && tail !== receiveId) {
    throw new Error(`receiveid 不匹配（收到 ${tail}）`)
  }
  return msg.toString('utf8')
}

/** 加密（主要用于自测回环与回执，实际入站只需解密）。 */
export function encryptWechatAes({ encodingAesKey, plain, receiveId = '' }) {
  const key = Buffer.from(String(encodingAesKey ?? '') + '=', 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey 非法（需要 43 位 base64）')
  const iv = key.subarray(0, 16)
  const body = Buffer.from(String(plain ?? ''), 'utf8')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(body.length, 0)
  const merged = Buffer.concat([randomBytes(16), lenBuf, body, Buffer.from(receiveId, 'utf8')])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(addPkcs7(merged, 32)), cipher.final()]).toString('base64')
}

// ── 飞书 ──────────────────────────────────────────────────────────────────

/** 飞书事件解密：key = sha256(encryptKey)，iv = 密文前 16 字节。 */
export function decryptFeishu({ encryptKey, encrypt }) {
  const key = createHash('sha256').update(String(encryptKey ?? ''), 'utf8').digest()
  const raw = Buffer.from(String(encrypt ?? ''), 'base64')
  if (raw.length <= 16) throw new Error('飞书密文过短')
  const iv = raw.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')
}

/** 飞书事件加密（自测回环用）。 */
export function encryptFeishu({ encryptKey, plain }) {
  const key = createHash('sha256').update(String(encryptKey ?? ''), 'utf8').digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const body = Buffer.concat([cipher.update(Buffer.from(String(plain ?? ''), 'utf8')), cipher.final()])
  return Buffer.concat([iv, body]).toString('base64')
}

// ── QQ（Ed25519）───────────────────────────────────────────────────────────

function normalizeHex(value, bytes, label) {
  const hex = String(value ?? '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== bytes * 2) {
    throw new Error(`${label} 必须是 ${bytes} 字节的 hex（${bytes * 2} 个字符）`)
  }
  return Buffer.from(hex, 'hex')
}

export function ed25519PublicKeyFromHex(hex) {
  const raw = normalizeHex(hex, 32, 'Ed25519 公钥')
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function ed25519PrivateKeyFromSeed(hex) {
  const seed = normalizeHex(hex, 32, 'Ed25519 私钥种子')
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

/** 校验入站签名：message = timestamp + body，signatureHex = X-Signature-Ed25519。 */
export function verifyEd25519({ publicKeyHex, message, signatureHex }) {
  const sig = Buffer.from(String(signatureHex ?? '').trim(), 'hex')
  if (sig.length !== 64) return false
  try {
    // 公钥格式非法（长度不对 / 不是 hex）也走「验签失败」而不是抛出：调用方拿到
    // 的是「这个请求不可信」，不该因为配置写错而把整个回调处理打成异常。
    const key = ed25519PublicKeyFromHex(publicKeyHex)
    return verify(null, Buffer.from(message, 'utf8'), key, sig)
  } catch {
    return false
  }
}

/** 回调地址校验签名：message = event_ts + plain_token。 */
export function signEd25519({ privateKeySeedHex, message }) {
  const key = ed25519PrivateKeyFromSeed(privateKeySeedHex)
  return sign(null, Buffer.from(message, 'utf8'), key).toString('hex')
}

// ── 极简 XML 读写（企业微信回调是 XML，且结构固定）────────────────────────

/** 取 <tag> 文本（支持 CDATA）；缺失返回 null。 */
export function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i').exec(String(xml ?? ''))
  if (!m) return null
  return m[1] !== undefined ? m[1] : m[2]
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
