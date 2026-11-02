#!/usr/bin/env node
/**
 * CDP browser-automation smoke test.
 *
 * Verifies the exact CDP calls `browser_snapshot` / `browser_act {ref}` rely on,
 * without booting the whole IDE:
 *
 *   Accessibility.enable + Accessibility.getFullAXTree  → AX tree with backend ids
 *   DOM.enable + DOM.resolveNode + Runtime.callFunctionOn → click a node by ref
 *
 * Run:  node_modules\electron\dist\electron.exe scripts/browser-cdp-smoke.mjs
 * (must be launched by Electron, not node — it needs BrowserWindow/webContents)
 */
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// electron.exe is a GUI-subsystem binary on Windows: stdout goes nowhere. Keep a
// log next to the script so the check is readable after the process exits.
const LOG_PATH = fileURLToPath(new URL('./.cdp-smoke.log', import.meta.url))
const lines = []
function log(message) {
  lines.push(message)
  console.log(message)
}
function flush() {
  try { writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8') } catch { /* best effort */ }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>cua-cdp-smoke</title></head>
<body>
  <h1>示例页面</h1>
  <button id="b" type="button">提交</button>
  <input id="i" aria-label="邮箱" />
  <a id="l" href="#">首页</a>
  <script>
    document.getElementById('b').addEventListener('click', () => { document.title = 'clicked' })
  </script>
</body></html>`

function fail(message) {
  log(`cdp-smoke: FAILED — ${message}`)
  flush()
  app.exit(1)
}

app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const wc = win.webContents
  try {
    await wc.loadURL(`http://127.0.0.1:${port}/`)
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Accessibility.enable')
    const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree')
    log(`ax nodes: ${nodes.length}`)

    const axValue = (v) => (v && typeof v.value === 'string' ? v.value : '')
    const button = nodes.find((n) => axValue(n.role) === 'button' && axValue(n.name).includes('提交'))
    const link = nodes.find((n) => axValue(n.role) === 'link' && axValue(n.name).includes('首页'))
    if (!button) return fail('找不到 button 节点')
    log(`roles ok: button="${axValue(button.name)}" backendNodeId=${button.backendDOMNodeId}`)
    log(`link found: ${!!link}`)

    await wc.debugger.sendCommand('DOM.enable')
    const resolved = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: button.backendDOMNodeId })
    const objectId = resolved?.object?.objectId
    if (!objectId) return fail('DOM.resolveNode 没有返回 objectId')

    const clicked = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.click(); return document.title }',
      returnByValue: true,
    })
    const title = await wc.executeJavaScript('document.title')
    if (title !== 'clicked') return fail(`点击没有生效（title=${title}）`)
    log(`click via ref ok: result=${JSON.stringify(clicked.result?.value)} title=${title}`)
    log('cdp-smoke: OK')
  } catch (error) {
    return fail(error?.message ?? String(error))
  } finally {
    flush()
    server.close()
    win.destroy()
    app.exit(0)
  }
})
