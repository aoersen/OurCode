import { describe, it, expect } from 'vitest'
import { imageAttachmentDataUrl, parseImageDataUrl } from '@/utils/imageAttach'

describe('parseImageDataUrl', () => {
  it('splits the media type from the payload', () => {
    expect(parseImageDataUrl('data:image/png;base64,iVBORw0=')).toEqual({
      mimeType: 'image/png',
      dataBase64: 'iVBORw0=',
    })
    expect(parseImageDataUrl('data:image/jpeg;base64,/9j/4AA=').mimeType).toBe('image/jpeg')
  })

  it('never leaves the ;base64 marker in the media type', () => {
    // A media type of "image/png;base64" is what broke the real app: Anthropic
    // rejects the request outright, and the <img> src came out double-prefixed.
    for (const url of ['data:image/png;base64,AAA', 'data:image/webp;base64,AAA']) {
      expect(parseImageDataUrl(url).mimeType).not.toContain(';')
    }
  })

  it('falls back to the file type, then to png, when the header is empty', () => {
    expect(parseImageDataUrl('data:;base64,AAA', 'image/gif')).toEqual({ mimeType: 'image/gif', dataBase64: 'AAA' })
    expect(parseImageDataUrl('data:,AAA').mimeType).toBe('image/png')
    // No data: header at all — treat the whole string as raw base64.
    expect(parseImageDataUrl('AAA', 'image/webp')).toEqual({ mimeType: 'image/webp', dataBase64: 'AAA' })
  })

  it('round-trips through imageAttachmentDataUrl', () => {
    const url = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    const { mimeType, dataBase64 } = parseImageDataUrl(url)
    expect(imageAttachmentDataUrl({ id: 'a', name: 'x.jpg', mimeType, dataBase64 })).toBe(url)
  })
})
