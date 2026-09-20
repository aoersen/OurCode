import { MessageAttachment } from '@/types'

/** Longest edge kept after downscaling. Above this the provider resamples
 *  anyway (Anthropic: 1568px), so sending the full-size original only costs
 *  upload bytes and SQLite bulk. */
export const MAX_IMAGE_EDGE = 1568

/** Files at or below this size are stored as-is — re-encoding a small PNG
 *  screenshot to JPEG would blur its text for no real gain. */
export const KEEP_AS_IS_BYTES = 1024 * 1024

export const MAX_IMAGES_PER_MESSAGE = 4

const JPEG_QUALITY = 0.85

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}

/** Data URL → possibly downscaled data URL. Never enlarges, and bails out to
 *  the original when anything in the decode/canvas path fails (a corrupt or
 *  unsupported image is the provider's problem to report, not ours to break). */
export async function downscaleImageDataUrl(dataUrl: string, byteSize: number): Promise<string> {
  try {
    const img = await decode(dataUrl)
    const width = img.naturalWidth || img.width
    const height = img.naturalHeight || img.height
    if (!width || !height) return dataUrl
    const longest = Math.max(width, height)
    if (longest <= MAX_IMAGE_EDGE && byteSize <= KEEP_AS_IS_BYTES) return dataUrl

    const scale = Math.min(1, MAX_IMAGE_EDGE / longest)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    // JPEG has no alpha — a transparent PNG would come out black without this.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    return dataUrl
  }
}

/** Split a data URL into `{ mimeType, dataBase64 }` — the shape the message
 *  model and the adapters want (base64 is stored WITHOUT the `data:` prefix).
 *  `;base64` is a transfer marker, not part of the media type: keeping it would
 *  put `image/png;base64` on the wire as Anthropic's `media_type`. */
export function parseImageDataUrl(dataUrl: string, fallbackMimeType = ''): { mimeType: string; dataBase64: string } {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return { mimeType: fallbackMimeType || 'image/png', dataBase64: dataUrl }
  const header = dataUrl.slice(5, comma)
  const semi = header.indexOf(';')
  const mimeType = (semi === -1 ? header : header.slice(0, semi)) || fallbackMimeType || 'image/png'
  return { mimeType, dataBase64: dataUrl.slice(comma + 1) }
}

/** Read + normalize one image into the message-attachment shape. base64 is
 *  stored WITHOUT the `data:` prefix — adapters build the URL per provider.
 *  FileReader is required here: the fs IPC text-decodes through iconv and
 *  would corrupt binary. */
export async function fileToImageAttachment(file: File, id: string): Promise<MessageAttachment> {
  const dataUrl = await readAsDataUrl(file)
  const scaled = await downscaleImageDataUrl(dataUrl, file.size)
  const { mimeType, dataBase64 } = parseImageDataUrl(scaled, file.type)
  return {
    id,
    name: file.name || 'image',
    mimeType,
    dataBase64,
  }
}

export function imageAttachmentDataUrl(att: MessageAttachment): string {
  return `data:${att.mimeType};base64,${att.dataBase64}`
}
