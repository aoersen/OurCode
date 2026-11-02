// Generate the self-signed localhost cert used by unit tests (no openssl needed
// on the dev box). Run once: `node scripts/gen-test-cert.mjs`.
//
// Outputs electron/__tests__/fixtures/self-signed-{cert,key}.pem. Test-only:
// CN=localhost + SAN DNS:localhost / IP:127.0.0.1, valid 2025-2100.
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'electron', '__tests__', 'fixtures')

// 鈹€鈹€ minimal DER encoder 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const len = (n) => {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8 }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))
const explicit = (n, body) => tlv(0xa0 + n, body)
const octet = (body) => tlv(0x04, body)
const bitString = (body, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), body]))
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'))
const utcTime = (s) => tlv(0x17, Buffer.from(s, 'ascii'))
const genTime = (s) => tlv(0x18, Buffer.from(s, 'ascii'))
const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]))
const integer = (value) => {
  let buf = Buffer.isBuffer(value) ? value : Buffer.from([value])
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
  return tlv(0x02, buf)
}
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number)
  const body = [40 * parts[0] + parts[1]]
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f]
    let v = p >>> 7
    while (v > 0) { enc.unshift((v & 0x7f) | 0x80); v >>>= 7 }
    body.push(...enc)
  }
  return tlv(0x06, Buffer.from(body))
}

const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)))
const cnLocalhost = seq(set(seq(oid('2.5.4.3'), utf8('localhost'))))

// 鈹€鈹€ key + certificate 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const spki = publicKey.export({ type: 'spki', format: 'der' })

const san = seq(tlv(0x82, Buffer.from('localhost', 'ascii')), tlv(0x87, Buffer.from([127, 0, 0, 1])))
const extensions = seq(
  seq(oid('2.5.29.19'), bool(true), octet(seq())),                                     // basicConstraints CA:FALSE
  seq(oid('2.5.29.17'), octet(san)),                                                   // subjectAltName
  seq(oid('2.5.29.15'), bool(true), octet(bitString(Buffer.from([0xa0]), 5))),          // keyUsage digitalSignature+keyEncipherment
)

const tbs = seq(
  explicit(0, integer(2)),                                    // version v3
  integer(Buffer.from('5f2e1c3d4b6a7988', 'hex')),            // serialNumber
  sha256WithRsa,
  cnLocalhost,                                                // issuer
  seq(utcTime('250101000000Z'), genTime('20491231235959Z')),  // validity
  cnLocalhost,                                                // subject
  spki,
  explicit(3, extensions),
)

const signature = sign('sha256', tbs, privateKey)
const certDer = seq(tbs, sha256WithRsa, bitString(signature))

const toPem = (label, der) =>
  `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'self-signed-cert.pem'), toPem('CERTIFICATE', certDer), 'ascii')
writeFileSync(join(outDir, 'self-signed-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), 'ascii')
console.log(`wrote ${join(outDir, 'self-signed-cert.pem')} and self-signed-key.pem`)

