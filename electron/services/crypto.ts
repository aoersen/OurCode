import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { machineIdSync } from 'node-machine-id'

const ALGORITHM = 'aes-256-gcm'
const SALT = 'OurCode-IDE-Salt-2024'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16

/**
 * At-rest encryption for the provider API keys.
 *
 * The key is derived from this machine's id plus a fixed, in-repo salt, so
 * anything running as this user can redo that derivation. What this protects
 * against is a stolen database file or a casual read of the config table — not
 * malware, and not another process the user runs. Chat transcripts are stored
 * as plaintext.
 */
export class CryptoService {
  private key: Buffer

  constructor() {
    const machineId = machineIdSync()
    this.key = scryptSync(machineId, SALT, KEY_LENGTH)
  }

  // --- Machine-ID based encryption (API keys) ---
  encrypt(text: string): Buffer {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted])
  }

  decrypt(buffer: Buffer): string {
    const iv = buffer.subarray(0, IV_LENGTH)
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  }

  // --- Master-key derivation shared by export/import ---

  /** Derive a 32-byte key from a password and salt using scrypt */
  private deriveKey(password: string, salt: string): Buffer {
    return scryptSync(password, salt, KEY_LENGTH) as Buffer
  }

  /** Encrypt string with a given key, return Buffer [IV|TAG|DATA] */
  private encryptWithKey(text: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted])
  }

  /** Decrypt buffer with a given key */
  private decryptWithKey(buffer: Buffer, key: Buffer): string {
    const iv = buffer.subarray(0, IV_LENGTH)
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  }

  // --- Export/Import encryption ---

  /** Encrypt text with a password for export. Returns base64-encoded salt+encrypted data. */
  encryptForExport(text: string, password: string): string {
    const salt = randomBytes(16).toString('hex')
    const key = this.deriveKey(password, salt)
    const encrypted = this.encryptWithKey(text, key)
    // Format: salt(hex):encrypted(base64)
    return `${salt}:${encrypted.toString('base64')}`
  }

  /** Decrypt text from import with a password. Throws on wrong password. */
  decryptForImport(encryptedData: string, password: string): string {
    const [salt, dataBase64] = encryptedData.split(':')
    if (!salt || !dataBase64) throw new Error('Invalid encrypted data format')
    const key = this.deriveKey(password, salt)
    const buffer = Buffer.from(dataBase64, 'base64')
    return this.decryptWithKey(buffer, key)
  }
}
