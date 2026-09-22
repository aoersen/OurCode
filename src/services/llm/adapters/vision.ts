import { LLMMessage } from '@/types'

type Image = NonNullable<LLMMessage['images']>[number]

/** `data:` URL for a stored image. Attachments keep base64 without the prefix
 *  (that is what SQLite stores), so adapters build the URL here. */
export function imageDataUrl(img: Image): string {
  return img.dataBase64.startsWith('data:')
    ? img.dataBase64
    : `data:${img.mimeType};base64,${img.dataBase64}`
}

/**
 * OpenAI Chat Completions multi-part `content` for a user turn that carries
 * images, or undefined when there is nothing to convert — callers then keep the
 * plain string content. Text-only turns stay strings on purpose: several
 * OpenAI-compatible gateways (and non-vision models behind them) reject the
 * array form.
 */
export function openAiVisionContent(
  m: Pick<LLMMessage, 'role' | 'content' | 'images'>
): Array<Record<string, unknown>> | undefined {
  if (m.role !== 'user' || !m.images?.length) return undefined
  const parts: Array<Record<string, unknown>> = []
  // An empty text part is dropped — some gateways reject zero-length text.
  if (m.content) parts.push({ type: 'text', text: m.content })
  for (const img of m.images) {
    parts.push({ type: 'image_url', image_url: { url: imageDataUrl(img) } })
  }
  return parts
}
