import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  readdir,
  stat as fsStat,
  mkdir,
  rename as fsRename,
  unlink,
  rm,
  copyFile as fsCopyFile,
  cp,
  open,
} from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { watch, FSWatcher } from 'chokidar'
import * as chardet from 'chardet'
import * as iconv from 'iconv-lite'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import { FileEntry, FileStat, FileStreamStart, FileStreamChunk } from '../../shared/types'

// Resolve chardet's entry so the encoding-detection worker can load it by an
// absolute path. `require` exists in the electron-vite CJS bundle but not under
// vitest's ESM transform, so fall back to createRequire on the CWD (project
// root in dev; Electron patches worker module loading to read from app.asar).
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(process.cwd())
const CHARDET_PATH = nodeRequire.resolve('chardet')

/**
 * Encoding detection follows the same strategy as VS Code's text-file service
 * (`src/vs/workbench/services/textfile/common/encoding.ts`): BOM first, then a
 * cheap zero-byte heuristic for BOM-less UTF-16 / binary files, and only then a
 * *sampled* chardet guess. The sample is capped at 64 KB — the same cap VS Code
 * passes to jschardet (`AUTO_ENCODING_GUESS_MAX_BYTES = 512 * 128`) — so the
 * cost is constant regardless of file size. Previously chardet ran on the whole
 * buffer: ~3s for a 17 MB file, scaling linearly and blocking the main process.
 * Files read entirely in the app (editor, global search) go through here, so
 * this also keeps search fast on large files.
 */
const ZERO_BYTE_SCAN_LEN = 512 // bytes scanned by the UTF-16 / binary heuristic
const MIN_GUESS_BYTES = 8 // below this, chardet output is noise; default to utf-8
const ENCODING_SAMPLE_SIZE = 64 * 1024 // 64 KB, matches VS Code's guess cap

// Chunked streaming reads: the editor opens files via `openStream`/`readNext` so
// a huge file is decoded chunk by chunk instead of one whole-buffer pass. This
// bounds peak memory and lets the renderer keep the UI responsive while loading.
const STREAM_HEAD_SIZE = ENCODING_SAMPLE_SIZE // first chunk doubles as the detection sample
const STREAM_CHUNK_SIZE = 1024 * 1024 // 1 MB per subsequent chunk

/** Byte-order marks, keyed by the normalized encoding name. */
const BOM_BYTES: Record<string, Buffer> = {
  'utf-8': Buffer.from([0xef, 0xbb, 0xbf]),
  'utf-16le': Buffer.from([0xff, 0xfe]),
  'utf-16be': Buffer.from([0xfe, 0xff]),
}

interface StreamState {
  fd: FileHandle
  decoder: ReturnType<typeof iconv.getDecoder>
  offset: number
  size: number
}

interface WriteStreamState {
  fd: FileHandle
  encoder: ReturnType<typeof iconv.getEncoder>
  finalPath: string
  tmpPath: string
  // A trailing lone high surrogate (e.g. the first half of an emoji) is held
  // back so a surrogate pair split across two `writeChunk` calls isn't mangled
  // by the per-chunk encode — iconv-lite encodes each chunk independently and
  // would otherwise turn each half into U+FFFD.
  pendingHigh: string
}

export class FileSystemService {
  private watchers: Map<string, FSWatcher> = new Map()
  private streamSeq = 0
  private streams = new Map<number, StreamState>()
  private writeSeq = 0
  /** Monotonic counter for unique temp-file names (see openWriteStream) */
  private tmpSeq = 0
  private writeStreams = new Map<number, WriteStreamState>()

  async readFile(filePath: string): Promise<{ content: string; encoding: string; hasBom: boolean }> {
    const buffer = await fsReadFile(filePath)
    const { encoding, hasBom } = this.detectEncodingInfo(buffer)
    // Whole-buffer reads (global search, revert) cross-check the middle and tail
    // for multibyte text after an ASCII head — off the main thread.
    const refined = await this.refineMultibyteEncoding(buffer, encoding)
    const content = iconv.decode(buffer, refined)
    return { content, encoding: refined, hasBom }
  }

  /**
   * Start a chunked read of a file. Returns the stream id, the detected
   * encoding/BOM and the already-decoded first chunk. The rest is pulled with
   * `readNext(id)` until it returns `done: true`.
   */
  async openStream(filePath: string): Promise<FileStreamStart> {
    const fd = await open(filePath, 'r')
    try {
      const size = (await fd.stat()).size
      const head = Buffer.alloc(STREAM_HEAD_SIZE)
      const { bytesRead } = await fd.read(head, 0, STREAM_HEAD_SIZE, 0)
      const headBytes = head.subarray(0, bytesRead)
      const { encoding, hasBom } = this.detectEncodingInfo(headBytes)
      const decoder = iconv.getDecoder(encoding)
      const id = ++this.streamSeq
      this.streams.set(id, { fd, decoder, offset: bytesRead, size })
      return { id, encoding, hasBom, totalBytes: size, chunk: decoder.write(headBytes) }
    } catch (error) {
      await fd.close()
      throw error
    }
  }

  /** Pull the next decoded chunk. Returns `null` for an unknown/closed stream. */
  async readNext(id: number): Promise<FileStreamChunk | null> {
    const s = this.streams.get(id)
    if (!s) return null
    if (s.offset >= s.size) {
      return this.finishStream(id, s)
    }
    const buf = Buffer.alloc(STREAM_CHUNK_SIZE)
    const { bytesRead } = await s.fd.read(buf, 0, STREAM_CHUNK_SIZE, s.offset)
    if (bytesRead <= 0) {
      return this.finishStream(id, s)
    }
    s.offset += bytesRead
    return { chunk: s.decoder.write(buf.subarray(0, bytesRead)), done: false }
  }

  /**
   * Pull up to `maxBytes` of decoded chunks in one call. Large files streamed
   * into the editor used one IPC round-trip per 1 MB chunk (~800 for an 800 MB
   * file); batching drops that to ~100 while keeping the decoder state intact
   * (chunks are still read sequentially in the main process). The last element
   * carries `done: true` when the stream reaches EOF; subsequent calls return
   * `null`.
   */
  async readBatch(id: number, maxBytes = 8 * 1024 * 1024): Promise<FileStreamChunk[] | null> {
    const s = this.streams.get(id)
    if (!s) return null
    const chunks: FileStreamChunk[] = []
    let totalBytes = 0
    while (totalBytes < maxBytes) {
      if (s.offset >= s.size) {
        chunks.push(await this.finishStream(id, s))
        break
      }
      const buf = Buffer.alloc(STREAM_CHUNK_SIZE)
      const { bytesRead } = await s.fd.read(buf, 0, STREAM_CHUNK_SIZE, s.offset)
      if (bytesRead <= 0) {
        chunks.push(await this.finishStream(id, s))
        break
      }
      s.offset += bytesRead
      totalBytes += bytesRead
      chunks.push({ chunk: s.decoder.write(buf.subarray(0, bytesRead)), done: false })
    }
    return chunks
  }

  /** Abort a stream early (e.g. the user cancelled the open). */
  async closeStream(id: number): Promise<void> {
    const s = this.streams.get(id)
    if (!s) return
    this.streams.delete(id)
    await s.fd.close()
  }

  private async finishStream(id: number, s: StreamState): Promise<FileStreamChunk> {
    this.streams.delete(id)
    await s.fd.close()
    // decoder.end() flushes any trailing partial multi-byte sequence
    return { chunk: s.decoder.end() ?? '', done: true }
  }

  // --- Streamed writes ------------------------------------------------------
  //
  // Saving a large file used to ship the whole `model.getValue()` string over
  // IPC (a multi-hundred-MB structured clone) and then iconv-encode it in one
  // synchronous pass — tens of seconds for a big file. Writing in chunks keeps
  // each IPC payload and encode step bounded, and still lands atomically via the
  // same temp-file + rename strategy as `writeFile`.

  /** Open a streamed write to `filePath`. Returns the write-stream id. */
  async openWriteStream(filePath: string, encoding = 'utf-8', hasBom = false): Promise<number> {
    const normalizedEncoding = this.normalizeEncoding(encoding)
    // Unique temp name per write — the old `.${basename}.${process.pid}.tmp`
    // collided when two saves of the SAME file overlapped (e.g. save-all plus
    // a manual save while a large streamed save is in flight), truncating each
    // other's temp file and corrupting the rename.
    const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${++this.tmpSeq}.tmp`)
    const fd = await open(tmpPath, 'w')
    const encoder = iconv.getEncoder(normalizedEncoding)
    const bom = BOM_BYTES[normalizedEncoding]
    if (hasBom && bom) await fd.write(bom)
    const id = ++this.writeSeq
    this.writeStreams.set(id, { fd, encoder, finalPath: filePath, tmpPath, pendingHigh: '' })
    return id
  }

  /** Append a decoded chunk to an open write stream (re-encoded incrementally). */
  async writeChunk(id: number, chunk: string): Promise<void> {
    const s = this.writeStreams.get(id)
    if (!s) return
    let text = chunk
    if (s.pendingHigh) {
      text = s.pendingHigh + text
      s.pendingHigh = ''
    }
    // Hold back a trailing lone high surrogate until the next chunk arrives.
    const lastCode = text.length > 0 ? text.charCodeAt(text.length - 1) : -1
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      s.pendingHigh = text.slice(-1)
      text = text.slice(0, -1)
    }
    const buf = s.encoder.write(text)
    if (buf && buf.length > 0) await s.fd.write(buf)
  }

  /** Flush, close and atomically rename the temp file into place. Resolves the
   *  final path so callers (e.g. the IPC handler) can react to the completed
   *  write — such as invalidating stale reverted-file records. */
  async closeWriteStream(id: number): Promise<string | undefined> {
    const s = this.writeStreams.get(id)
    if (!s) return undefined
    this.writeStreams.delete(id)
    if (s.pendingHigh) {
      const buf = s.encoder.write(s.pendingHigh)
      if (buf && buf.length > 0) await s.fd.write(buf)
    }
    const tail = s.encoder.end()
    if (tail && tail.length > 0) await s.fd.write(tail)
    await s.fd.close()
    await fsRename(s.tmpPath, s.finalPath)
    return s.finalPath
  }

  /** Abort an in-progress write, removing the temp file. */
  async abortWriteStream(id: number): Promise<void> {
    const s = this.writeStreams.get(id)
    if (!s) return
    this.writeStreams.delete(id)
    await s.fd.close().catch(() => {})
    await rm(s.tmpPath, { force: true }).catch(() => {})
  }

  /**
   * Detect the text encoding of a buffer (BOM, zero-byte heuristic, sampled
   * guess) and whether it started with a byte-order mark. Only the head sample
   * is guessed here (constant cost); callers that hold the whole buffer call
   * `refineMultibyteEncoding` afterwards for the middle/tail cross-check.
   */
  private detectEncodingInfo(buffer: Buffer): { encoding: string; hasBom: boolean } {
    // 1) BOM — unambiguous and cheaper than any guess
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return { encoding: 'utf-8', hasBom: true }
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { encoding: 'utf-16le', hasBom: true }
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { encoding: 'utf-16be', hasBom: true }
    }

    // 2) zero-byte heuristic — BOM-less UTF-16 (which chardet mislabels as UTF-8)
    //    and binary files are decided here, before any guessing (same as VS Code)
    const byZeroBytes = this.detectUtf16OrBinary(buffer)
    if (byZeroBytes) return { encoding: byZeroBytes, hasBom: false }

    // 3) sampled chardet guess — constant cost, independent of file size
    if (buffer.length < MIN_GUESS_BYTES) return { encoding: 'utf-8', hasBom: false }

    const detected = chardet.detect(this.sampleAt(buffer, 0)) || 'utf-8'
    return { encoding: this.normalizeEncoding(detected), hasBom: false }
  }

  /**
   * A large file whose head is pure ASCII may still hold multibyte text further
   * in (e.g. an ASCII SQL header followed by Chinese comments). Cross-check the
   * middle and tail; prefer the first multibyte guess over a single-byte one.
   * The chardet runs are moved to a worker thread so search over large files
   * doesn't block the main process; falls back to the synchronous loop when the
   * worker is unavailable (e.g. some test runners).
   */
  async refineMultibyteEncoding(buffer: Buffer, headGuess: string): Promise<string> {
    if (buffer.length <= ENCODING_SAMPLE_SIZE || !isSingleByteEncoding(headGuess)) {
      return headGuess
    }
    const offsets = [Math.floor(buffer.length / 2), Math.max(0, buffer.length - ENCODING_SAMPLE_SIZE)]
    const samples = offsets.map((offset) => this.sampleAt(buffer, offset))

    const workerGuess = await detectWithWorker(samples)
    if (workerGuess && !isSingleByteEncoding(workerGuess)) {
      return this.normalizeEncoding(workerGuess)
    }

    // Fallback: same synchronous cross-check as before the worker
    let detected = headGuess
    for (const sample of samples) {
      const candidate = chardet.detect(sample)
      if (candidate && !isSingleByteEncoding(candidate)) {
        detected = candidate
        break
      }
    }
    return this.normalizeEncoding(detected)
  }

  private sampleAt(buffer: Buffer, offset: number): Buffer {
    return buffer.subarray(offset, offset + ENCODING_SAMPLE_SIZE)
  }

  /**
   * Scan the first bytes for zero-byte patterns (VS Code's
   * `detectEncodingFromBuffer`): consistent parity means UTF-16 LE/BE without a
   * BOM, any other zero-byte pattern means a binary file. Returns null for text
   * files (no zero bytes) so the caller falls through to chardet.
   */
  private detectUtf16OrBinary(buffer: Buffer): string | null {
    let couldBeUTF16LE = true // e.g. 0xAA 0x00
    let couldBeUTF16BE = true // e.g. 0x00 0xAA
    let containsZeroByte = false

    const len = Math.min(buffer.length, ZERO_BYTE_SCAN_LEN)
    for (let i = 0; i < len; i++) {
      const isEndian = i % 2 === 1
      const isZeroByte = buffer[i] === 0

      if (isZeroByte) containsZeroByte = true
      if (couldBeUTF16LE && (isEndian ? !isZeroByte : isZeroByte)) couldBeUTF16LE = false
      if (couldBeUTF16BE && (isEndian ? isZeroByte : !isZeroByte)) couldBeUTF16BE = false
      if (isZeroByte && !couldBeUTF16LE && !couldBeUTF16BE) break
    }

    if (containsZeroByte) {
      if (couldBeUTF16LE) return 'utf-16le'
      if (couldBeUTF16BE) return 'utf-16be'
      return 'utf-8' // binary file: decode lossily as UTF-8, skip the guess
    }
    return null
  }

  async writeFile(filePath: string, content: string, encoding: string = 'utf-8', hasBom = false): Promise<void> {
    const normalizedEncoding = this.normalizeEncoding(encoding)
    let buffer = iconv.encode(content, normalizedEncoding)
    // Preserve the original byte-order mark (VS Code does the same; stripping it
    // silently would change the file's encoding on save)
    const bom = BOM_BYTES[normalizedEncoding]
    if (hasBom && bom) {
      buffer = Buffer.concat([bom, buffer])
    }
    // Write to a temp sibling then rename, so a crash mid-write never corrupts
    // the original file (same strategy as VS Code's disk file service). The
    // dot-prefixed name is also ignored by the chokidar watcher. The unique
    // token prevents two overlapping writes of the same file from truncating
    // each other's temp file.
    const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${++this.tmpSeq}.tmp`)
    try {
      await fsWriteFile(tmpPath, buffer)
      await fsRename(tmpPath, filePath)
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      // Directory doesn't exist yet (e.g. <userData>/skills before first run) — treat as empty.
      return []
    }
    // Stat every entry in PARALLEL — a sequential await loop stalls for a
    // noticeable beat on directories with hundreds/thousands of files.
    const result = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dirPath, entry.name)
        const isHidden = entry.name.startsWith('.')
        try {
          const stats = await fsStat(fullPath)
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isHidden,
            size: entry.isFile() ? stats.size : undefined,
            modifiedAt: stats.mtimeMs,
          }
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            isHidden,
          }
        }
      }),
    )

    // Sort: directories first, then by name
    return result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  async createFile(filePath: string): Promise<void> {
    await fsWriteFile(filePath, '', 'utf-8')
  }

  async createDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fsRename(oldPath, newPath)
  }

  async delete(filePath: string): Promise<void> {
    const stats = await fsStat(filePath)
    if (stats.isDirectory()) {
      await rm(filePath, { recursive: true, force: true })
    } else {
      await unlink(filePath)
    }
  }

  async copy(src: string, dest: string): Promise<void> {
    const stats = await fsStat(src)
    if (stats.isDirectory()) {
      await cp(src, dest, { recursive: true })
    } else {
      await fsCopyFile(src, dest)
    }
  }

  async move(src: string, dest: string): Promise<void> {
    await fsRename(src, dest)
  }

  async stat(filePath: string): Promise<FileStat> {
    const stats = await fsStat(filePath)
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      createdAt: stats.birthtimeMs,
      modifiedAt: stats.mtimeMs,
    }
  }

  watch(dirPath: string, onChange: (path: string) => void): void {
    if (this.watchers.has(dirPath)) {
      return
    }

    // Skip heavy, machine-generated directories (and VCS internals) so the
    // watcher doesn't track tens of thousands of files — node_modules in a big
    // project alone would otherwise keep that many fs watchers alive in the
    // main process and flood the renderer with change events during installs /
    // builds. The file tree still lists these directories (listDir is separate);
    // only change events for them are dropped.
    //
    // Build/output dirs (dist / build / out / coverage / release*) are included
    // for the same reason: running a build emits hundreds/thousands of change
    // events, which would otherwise spam the renderer with fs:fileChanged IPC
    // and force a full file-tree refresh. This list is kept in sync with
    // main.ts's DEFAULT_EXCLUDE_FOLDERS so the watcher and the search index
    // agree on what is machine-generated (search index also excludes .next /
    // .nuxt / .output / coverage, which are harmless here).
    const HEAVY_WATCH_DIRS = /(^|[/\\])(node_modules|\.git|\.hg|\.svn|\.idea|\.vscode|\.cache|__pycache__|dist|build|out|coverage|\.next|\.nuxt|\.output|release(?:-[^/\\]+)?)([/\\]|$)/

    const watcher = watch(dirPath, {
      ignored: (p: string) => /(^|[/\\])\../.test(p) || HEAVY_WATCH_DIRS.test(p),
      persistent: true,
      ignoreInitial: true,
      depth: 10,
    })

    watcher.on('change', (path) => onChange(path))
    watcher.on('add', (path) => onChange(path))
    watcher.on('unlink', (path) => onChange(path))
    // chokidar emits 'error' on EPERM/ENOENT races (dir deleted out from under
    // us, antivirus locks, ...). Without a listener Node throws the error
    // uncaught and kills the whole main process.
    watcher.on('error', (err) => {
      console.error(`[fs] watcher error for ${dirPath}:`, err)
    })

    this.watchers.set(dirPath, watcher)
  }

  unwatch(dirPath: string): void {
    const watcher = this.watchers.get(dirPath)
    if (watcher) {
      watcher.close()
      this.watchers.delete(dirPath)
    }
  }

  unwatchAll(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close()
    }
    this.watchers.clear()
  }

  private normalizeEncoding(encoding: string): string {
    const lower = encoding.toLowerCase()
    if (lower === 'gb2312' || lower === 'gbk' || lower === 'gb18030') {
      return 'gbk'
    }
    if (lower.startsWith('utf-8') || lower === 'utf8') {
      return 'utf-8'
    }
    if (lower === 'ascii') {
      return 'utf-8'
    }
    return lower
  }
}

/** Single-byte encodings — a head sample that yields one of these may be
 *  masking multibyte text later in the file, so we cross-check the middle. */
function isSingleByteEncoding(encoding: string): boolean {
  return /^(ascii|iso-?8859-1|latin-?1|windows-125[0-9]|macroman|koi8-?r|ibm[0-9]+)$/i.test(encoding)
}

/**
 * Run chardet over samples in a worker thread so a multi-hundred-MB file scan
 * doesn't block the main process. Returns null on failure/timeout so callers
 * fall back to the synchronous path. The worker script is self-contained (eval
 * classic worker) and loads chardet by the absolute path resolved above.
 */
function detectWithWorker(samples: Buffer[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: string | null): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    try {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('worker_threads')
        const chardet = require(workerData.chardetPath)
        const results = workerData.samples.map((sample) => chardet.detect(Buffer.from(sample)))
        parentPort.postMessage(results)
        `,
        {
          eval: true,
          workerData: { chardetPath: CHARDET_PATH, samples },
        },
      )
      const timer = setTimeout(() => {
        worker.terminate().catch(() => {})
        done(null)
      }, 2000)
      worker.once('message', (results: unknown) => {
        clearTimeout(timer)
        done(Array.isArray(results) && typeof results[0] === 'string' ? results[0] : null)
      })
      worker.once('error', () => {
        clearTimeout(timer)
        done(null)
      })
    } catch {
      done(null)
    }
  })
}
