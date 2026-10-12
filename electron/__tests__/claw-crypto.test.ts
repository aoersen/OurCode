import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

import {
  addPkcs7,
  decryptFeishu,
  decryptWechatAes,
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyFromHex,
  encryptFeishu,
  encryptWechatAes,
  signEd25519,
  stripPkcs7,
  timingSafeEqualStr,
  verifyEd25519,
  wechatSignature,
  xmlEscape,
  xmlValue,
} from '../claw-gateway/crypto.mjs'

/**
 * Claw 网关的协议加密工具单测（离线）。
 *
 * 这些函数决定「回调消息到底是不是平台发来的、内容有没有被篡改」，错了就是安全
 * 问题，因此不测「看着像」而测**回环**：用同一规范加密再解密、用真实密钥对签
 * 名再验签、篡改一个字节必须失败。
 */
const NL = String.fromCharCode(10)

/** 生成一个合法的 43 位 EncodingAESKey（企业微信/微信公众平台的格式）。 */
function makeAesKey(): string {
  return randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43)
}

describe('企业微信 / 微信 AES', () => {
  it('加解密回环（含中文与 XML）', () => {
    const key = makeAesKey()
    const plain = '<xml><Content>你好，Claw</Content></xml>'
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain, receiveId: 'ww123' })
    expect(decryptWechatAes({ encodingAesKey: key, encrypt, receiveId: 'ww123' })).toBe(plain)
  })

  it('receiveid 不匹配时拒绝（防止把别人的回调塞进来）', () => {
    const key = makeAesKey()
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain: 'x', receiveId: 'ww-corp-a' })
    expect(() => decryptWechatAes({ encodingAesKey: key, encrypt, receiveId: 'ww-corp-b' })).toThrow()
  })

  it('未配置 receiveid 时不校验（单机调试路径）', () => {
    const key = makeAesKey()
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain: 'x', receiveId: 'ww-a' })
    expect(decryptWechatAes({ encodingAesKey: key, encrypt, receiveId: '' })).toBe('x')
  })

  it('EncodingAESKey 长度非法时明确报错', () => {
    expect(() => decryptWechatAes({ encodingAesKey: 'too-short', encrypt: 'AAAA', receiveId: '' })).toThrow(/EncodingAESKey/)
  })

  it('密文被破坏时解密失败（PKCS7 校验）', () => {
    const key = makeAesKey()
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain: 'hello', receiveId: '' })
    const raw = Buffer.from(encrypt, 'base64')
    // 翻转最后一个字节：填充不再合法
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff
    expect(() => decryptWechatAes({ encodingAesKey: key, encrypt: raw.toString('base64'), receiveId: '' })).toThrow()
  })

  it('PKCS7 填充/去填充（块长 32）', () => {
    expect(stripPkcs7(addPkcs7(Buffer.from('abc'), 32), 32).toString()).toBe('abc')
    expect(addPkcs7(Buffer.alloc(32), 32)).toHaveLength(64) // 整块对齐时补满一整块
    // 非法填充字节抛错（不能被当成正常内容交给上层）
    expect(() => stripPkcs7(Buffer.from([1, 2, 99]), 32)).toThrow(/PKCS7/)
    expect(() => stripPkcs7(Buffer.alloc(0), 32)).toThrow()
  })

  it('长度字段越界时拒绝（篡改不会静默截断）', () => {
    const key = makeAesKey()
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain: 'hi', receiveId: '' })
    const raw = Buffer.from(encrypt, 'base64')
    // 只改长度字段所在密文块：解密后长度字段越界（或填充非法），两种都必须抛错
    raw[32] = raw[32] ^ 0x01
    expect(() => decryptWechatAes({ encodingAESKey: key, encrypt: raw.toString('base64'), receiveId: '' })).toThrow()
  })
})

describe('飞书 AES', () => {
  it('加解密回环', () => {
    const plain = JSON.stringify({ schema: '2.0', header: { event_type: 'im.message.receive_v1' } })
    const encrypt = encryptFeishu({ encryptKey: 'my-encrypt-key', plain })
    expect(decryptFeishu({ encryptKey: 'my-encrypt-key', encrypt })).toBe(plain)
  })

  it('Encrypt Key 不同解不出来', () => {
    const encrypt = encryptFeishu({ encryptKey: 'key-a', plain: 'secret' })
    expect(() => decryptFeishu({ encryptKey: 'key-b', encrypt })).toThrow()
  })

  it('过短密文被拒绝', () => {
    expect(() => decryptFeishu({ encryptKey: 'k', encrypt: Buffer.from('12345678').toString('base64') })).toThrow()
  })
})

describe('签名与常量时间比较', () => {
  it('wechatSignature 与参数顺序无关，与拼接顺序有关', () => {
    expect(wechatSignature(['tok', '100', 'nonce', 'enc'])).toBe(wechatSignature(['enc', 'nonce', '100', 'tok']))
    expect(wechatSignature(['tok', '100', 'nonce', 'enc'])).not.toBe(wechatSignature(['tok', '100', 'nonce', 'enc2']))
  })

  it('timingSafeEqualStr 只认完全相等', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualStr(undefined, 'abc')).toBe(false)
  })
})

describe('QQ Ed25519', () => {
  /** 生成一对 Ed25519 密钥，导出裸 seed / 裸公钥（QQ 后台给的就是这两种 hex）。 */
  function rawKeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    return { seed: pkcs8.subarray(pkcs8.length - 32).toString('hex'), pub: spki.subarray(spki.length - 32).toString('hex') }
  }

  it('回调地址校验：私钥种子签名 + 平台公钥验签通过', () => {
    const { seed, pub } = rawKeyPair()
    const message = `1726000000${'tok' + 'en'}`
    const signature = signEd25519({ privateKeySeedHex: seed, message })
    expect(verifyEd25519({ publicKeyHex: pub, message, signatureHex: signature })).toBe(true)
  })

  it('消息被改动即验签失败（防篡改）', () => {
    const { seed, pub } = rawKeyPair()
    const signature = signEd25519({ privateKeySeedHex: seed, message: 'a' + 'b' })
    expect(verifyEd25519({ publicKeyHex: pub, message: 'a' + 'c', signatureHex: signature })).toBe(false)
  })

  it('公钥/签名格式非法时返回 false 而不是抛出', () => {
    const { seed } = rawKeyPair()
    const signature = signEd25519({ privateKeySeedHex: seed, message: 'x' })
    expect(verifyEd25519({ publicKeyHex: 'zz', message: 'x', signatureHex: signature })).toBe(false)
    expect(verifyEd25519({ publicKeyHex: 'a'.repeat(64), message: 'x', signatureHex: 'not-hex' })).toBe(false)
  })

  it('种子长度非法时签名抛错（配置错误要立刻可见）', () => {
    expect(() => signEd25519({ privateKeySeedHex: 'abcd', message: 'x' })).toThrow(/Ed25519/)
    expect(() => ed25519PrivateKeyFromSeed('not-hex-at-all')).toThrow()
    // 合法长度的 hex 能构出可用的 Ed25519 公钥对象
    expect(ed25519PublicKeyFromHex('0'.repeat(64)).asymmetricKeyType).toBe('ed25519')
  })
})

describe('XML 取值', () => {
  it('取普通文本与 CDATA', () => {
    const xml = `<xml><Encrypt><![CDATA[abc<>&]]></Encrypt>${NL}<MsgType>text</MsgType></xml>`
    expect(xmlValue(xml, 'Encrypt')).toBe('abc<>&')
    expect(xmlValue(xml, 'MsgType')).toBe('text')
    expect(xmlValue(xml, 'Missing')).toBeNull()
  })

  it('标签名大小写不敏感（企业微信文档里大小写不统一）', () => {
    expect(xmlValue('<xml><msGtype>text</msGtype></xml>', 'MsgType')).toBe('text')
  })

  it('xmlEscape 转义四个危险字符', () => {
    expect(xmlEscape('<a&"b>')).toBe('&lt;a&amp;&quot;b&gt;')
  })
})
