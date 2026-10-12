/**
 * Stub for `openclaw/plugin-sdk/infra-runtime`. Provides the two utilities the
 * Weixin protocol layer uses: a temp dir for its log file and a best-effort
 * file lock.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw")
}

export function resolvePreferredOpenClawTmpDir() {
  const dir = path.join(stateDir(), "tmp")
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // best-effort; the logger tolerates a missing dir
  }
  return dir
}

export async function withFileLock(filePath, fn) {
  const lockPath = `${filePath}.lock`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const handle = fs.openSync(lockPath, "wx")
      fs.closeSync(handle)
      break
    } catch (err) {
      if (err?.code !== "EEXIST" || Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // best-effort
    }
  }
}
