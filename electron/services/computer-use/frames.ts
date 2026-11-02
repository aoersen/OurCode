/**
 * Computer Use — screenshot frame registry.
 *
 * Coordinates are only meaningful inside the raster the model actually saw, so
 * every screenshot becomes a `frameId` with a TTL and an LRU cap. A coordinate
 * click must name a live frame; element bounds are never accepted as a
 * substitute (they are global desktop points and can be off by DPI/scroll).
 */
import { existsSync, readFileSync, unlinkSync } from 'fs'
import {
  CUA_FRAME_LRU,
  CUA_FRAME_TTL_MS,
  type CuaFrameInfo,
  type CuaImageRef,
  isFrameActionable,
} from '../../../shared/computer'

export interface FrameRecord extends CuaFrameInfo {
  owner: string
  path: string
}

export interface RawFrame {
  path: string
  width: number
  height: number
  scale?: number
  unit?: CuaImageRef['unit']
}

export class FrameStore {
  private map = new Map<string, FrameRecord>()
  private seq = 0

  constructor(
    private readonly ttlMs = CUA_FRAME_TTL_MS,
    private readonly lru = CUA_FRAME_LRU,
  ) {}

  register(owner: string, raw: RawFrame, now = Date.now()): FrameRecord {
    this.seq += 1
    const record: FrameRecord = {
      frameId: `frame-${now.toString(36)}-${this.seq}`,
      owner,
      path: raw.path,
      width: Math.max(1, Math.round(raw.width)),
      height: Math.max(1, Math.round(raw.height)),
      scale: raw.scale && raw.scale > 0 ? raw.scale : 1,
      unit: raw.unit ?? (process.platform === 'win32' ? 'physical_pixel' : process.platform === 'darwin' ? 'point' : 'x11_root_pixel'),
      capturedAt: now,
    }
    this.map.set(record.frameId, record)
    this.prune(now)
    return record
  }

  latest(owner: string): FrameRecord | undefined {
    let latest: FrameRecord | undefined
    for (const record of this.map.values()) {
      if (record.owner !== owner) continue
      if (!latest || record.capturedAt >= latest.capturedAt) latest = record
    }
    return latest
  }

  get(frameId: string | undefined): FrameRecord | undefined {
    if (!frameId) return undefined
    return this.map.get(frameId)
  }

  isActionable(owner: string, frameId: string | undefined, now = Date.now()): boolean {
    const record = this.get(frameId)
    return !!record && record.owner === owner && isFrameActionable(record, now, this.ttlMs)
  }

  /** PNG → data URL for the renderer (screenshots never cross IPC as raw bytes). */
  dataUrl(record: FrameRecord | undefined): string | undefined {
    if (!record || !existsSync(record.path)) return undefined
    try {
      const buf = readFileSync(record.path)
      if (buf.length < 8) return undefined
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return undefined
    }
  }

  prune(now = Date.now()): void {
    const live = [...this.map.values()]
      .filter((r) => isFrameActionable(r, now, this.ttlMs))
      .sort((a, b) => a.capturedAt - b.capturedAt)
    const keep = new Set(live.slice(-this.lru).map((r) => r.frameId))
    for (const [id, record] of [...this.map]) {
      if (keep.has(id)) continue
      this.map.delete(id)
      // Frame files are scratch data; drop them eagerly.
      try { if (existsSync(record.path)) unlinkSync(record.path) } catch { /* best effort */ }
    }
  }

  clearOwner(owner: string): void {
    for (const [id, record] of [...this.map]) {
      if (record.owner !== owner) continue
      this.map.delete(id)
      try { if (existsSync(record.path)) unlinkSync(record.path) } catch { /* best effort */ }
    }
  }
}
