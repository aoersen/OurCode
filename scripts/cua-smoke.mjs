#!/usr/bin/env node
/**
 * CUA helper smoke test (Windows).
 *
 * Drives `tools/cua-helper/win/UiaBridge.ps1` over NDJSON exactly like the main
 * process does, but without Electron: handshake → list_apps → capture_app →
 * screenshot → shutdown. Read-only: it never clicks or types.
 *
 * Usage:
 *   node scripts/cua-smoke.mjs                 # first titled window
 *   node scripts/cua-smoke.mjs "记事本"         # window name substring
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const winDir = join(here, '..', 'tools', 'cua-helper', 'win')
const exePath = join(winDir, 'CuaHelper.exe')
const psPath = join(winDir, 'UiaBridge.ps1')
// OURCODE_CUA_HELPER=ps forces the PowerShell bridge; default prefers the
// compiled C# helper (same protocol, no PS startup cost).
const wantPs = process.env.OURCODE_CUA_HELPER === 'ps'
const useExe = !wantPs && existsSync(exePath)
if (!useExe && !existsSync(psPath)) {
  console.error(`helper not found in ${winDir}`)
  process.exit(2)
}
const filter = process.argv[2] ?? ''
const token = randomBytes(32).toString('hex')
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const command = useExe ? exePath : existsSync(ps) ? ps : 'powershell.exe'
const args = useExe
  ? []
  : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath]
console.log(`backend: ${useExe ? 'native (CuaHelper.exe)' : 'powershell (UiaBridge.ps1)'}`)

const child = spawn(command, args, { env: { ...process.env, OURCODE_CUA_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[helper:stderr] ${chunk}`))

let buffer = ''
let nextId = 1
const pending = new Map()

child.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) {
      try {
        const msg = JSON.parse(line)
        const waiter = pending.get(msg.id)
        if (waiter) {
          pending.delete(msg.id)
          msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(`${msg.error?.code}: ${msg.error?.message}`))
        }
      } catch {
        console.error('[helper:non-json]', line.slice(0, 200))
      }
    }
    nl = buffer.indexOf('\n')
  }
})

function call(method, params = {}) {
  const id = nextId++
  const line = JSON.stringify({ id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 20_000)
    const wrap = pending.get(id)
    wrap.resolve = (v) => { clearTimeout(timer); resolve(v) }
    wrap.reject = (e) => { clearTimeout(timer); reject(e) }
    child.stdin.write(`${line}\n`)
  })
}

function report(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

try {
  const hello = await call('hello', { token, protocol: 'cua-ips/1', pid: process.pid })
  report('hello', hello)

  const apps = await call('list_apps')
  const list = Array.isArray(apps.apps) ? apps.apps : apps.apps ? [apps.apps] : []
  report('windows', list.length)
  for (const app of list.slice(0, 8)) {
    console.log(`  - ${app.name} | ${app.title} | pid=${app.pid} window=${app.windowId}`)
  }

  const target = filter
    ? list.find((a) => `${a.name} ${a.title}`.includes(filter))
    : list.find((a) => a.title)
  if (!target) {
    console.log(`no window matched "${filter}"`)
  } else {
    const state = await call('capture_app', {
      app: { pid: target.pid, windowId: target.windowId },
      maxNodes: 60,
    })
    const elements = Array.isArray(state.elements) ? state.elements : state.elements ? [state.elements] : []
    console.log(`capture_app: ${elements.length} nodes, truncated=${state.truncated}`)
    for (const el of elements.slice(0, 12)) {
      const acts = Array.isArray(el.actions) ? el.actions : el.actions ? [el.actions] : []
      console.log(`  [${el.index}] ${el.role} "${el.name ?? ''}"${el.value ? ` value="${String(el.value).slice(0, 40)}"` : ''}${acts.length ? ` actions=[${acts.join(',')}]` : ''}`)
    }
    const shot = await call('screenshot', { target: 'window', app: { pid: target.pid, windowId: target.windowId } })
    report('screenshot', { width: shot.width, height: shot.height, path: shot.path })
  }

  await call('shutdown')
  child.stdin.end()
  console.log('smoke: OK')
} catch (error) {
  console.error('smoke: FAILED —', error.message)
  process.exitCode = 1
} finally {
  setTimeout(() => child.kill(), 300)
}
