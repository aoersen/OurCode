#!/usr/bin/env node
/**
 * Real-input smoke test for browser_act.
 *
 * Verifies the CDP contract the new implementation relies on, without booting
 * the whole IDE:
 *
 *   Input.dispatchMouseEvent  → trusted pointerdown/mousedown/mouseup/click
 *   Input.dispatchMouseEvent (mouseWheel) → real wheel scrolling
 *   Input.insertText          → trusted input event / controlled-field value
 *   Input.dispatchKeyEvent    → trusted keydown + native Enter submit
 *   DOM.getFrameOwner         → same-origin iframe coordinate translation
 *
 * Run (Electron, not node):
 *   node_modules\electron\dist\electron.exe scripts/browser-input-smoke.mjs
 */

import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOG_PATH = fileURLToPath(new URL('./.browser-input-smoke.log', import.meta.url))
const lines = []
function log(message) {
  lines.push(message)
  console.log(message)
}
function flush() {
  try { writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8') } catch { /* best effort */ }
}
function fail(message) {
  log(`browser-input-smoke: FAILED — ${message}`)
  flush()
  app.exit(1)
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>input-smoke</title>
<style>
  body { font-family: sans-serif; margin: 20px; }
  #scroller { height: 120px; overflow-y: auto; border: 1px solid #ccc; width: 260px; margin-top: 20px; }
  #scroller div { height: 30px; }
  #box { width: 120px; height: 80px; background: #ddd; margin-top: 20px; }
</style></head>
<body>
  <button id="btn" type="button">提交</button>
  <input id="field" aria-label="邮箱" />
  <form id="form" onsubmit="window.__submitted = true; return false">
    <input id="formfield" aria-label="表单输入" />
    <button type="submit">Go</button>
  </form>
  <div id="scroller">${Array.from({ length: 30 }, (_, i) => `<div>row ${i}</div>`).join('')}</div>
  <div id="box"></div>
  <iframe id="frame" style="width: 300px; height: 120px; display: block; margin-top: 20px"></iframe>
  <script>
    window.__log = []
    window.__keys = []
    window.__drag = { moves: 0, down: false, lastX: 0, lastY: 0 }
    const push = (type, e) => window.__log.push({ type, trusted: e.isTrusted })
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      document.getElementById('btn').addEventListener(type, (e) => push(type, e))
    }
    document.getElementById('field').addEventListener('input', (e) => {
      window.__log.push({ type: 'input', trusted: e.isTrusted, value: e.target.value })
    })
    document.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, trusted: e.isTrusted }))
    document.getElementById('scroller').addEventListener('wheel', (e) => {
      window.__wheel = { deltaY: e.deltaY, trusted: e.isTrusted, x: e.clientX, y: e.clientY }
    })
    const box = document.getElementById('box')
    box.addEventListener('pointerdown', (e) => {
      window.__drag.down = true
      window.__drag.lastX = e.clientX
      window.__drag.lastY = e.clientY
    })
    for (const type of ['pointermove', 'mousemove']) {
      document.addEventListener(type, (e) => {
        if (!window.__drag.down) return
        window.__drag.moves += 1
        window.__drag.lastX = e.clientX
        window.__drag.lastY = e.clientY
      })
    }
    box.addEventListener('pointerup', () => { window.__drag.down = false })
    // srcdoc keeps the frame in-process, so DOM.describeNode exposes its
    // contentDocument (a separate URL iframe can be an OOPIF with no handle).
    const frame = document.getElementById('frame');
    frame.srcdoc = '<body style="margin:0"><button id="inner" style="position:absolute;left:30px;top:30px;width:140px;height:40px">内层按钮</button></body>';
    frame.addEventListener('load', () => {
      const inner = frame.contentDocument && frame.contentDocument.getElementById('inner');
      if (inner) inner.addEventListener('click', (e) => { parent.__innerClicked = e.isTrusted; });
    });
  </script>
</body></html>`

const FRAME_PAGE = `<!doctype html><html><body style="margin:0">
  <button id="inner" style="margin:30px;width:140px;height:40px">内层按钮</button>
  <script>
    document.getElementById('inner').addEventListener('click', (e) => { parent.__innerClicked = e.isTrusted })
  </script>
</body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/frame' ? FRAME_PAGE : PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 820,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The real browser session disables throttling; without it a hidden
      // window intermittently drops wheel/compositor input.
      backgroundThrottling: false,
    },
  })
  const wc = win.webContents
  const cdp = (method, params = {}) => wc.debugger.sendCommand(method, params)
  const evaluate = (expression) => wc.executeJavaScript(expression, true)

  try {
    await wc.loadURL(`http://127.0.0.1:${port}/`)
    wc.debugger.attach('1.3')
    await cdp('Page.enable')
    await cdp('DOM.enable')

    const objectIdFor = async (expression) => {
      const res = await cdp('Runtime.evaluate', { expression, returnByValue: false })
      if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.text}`)
      const objectId = res.result?.objectId
      if (!objectId) throw new Error(`no objectId for ${expression}`)
      return objectId
    }

    const measure = async (objectId) => {
      const res = await cdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) {}
          const r = this.getBoundingClientRect();
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
        }`,
        returnByValue: true,
      })
      const parsed = JSON.parse(res.result.value)
      assert(parsed.w > 0 && parsed.h > 0, 'target has zero size')
      return parsed
    }

    const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), ...extra,
    })

    const clickAt = async (x, y) => {
      await mouse('mouseMoved', x, y, { button: 'none', buttons: 0 })
      await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(80)
    }

    // 1) Real click by node geometry -----------------------------------------
    const btnId = await objectIdFor(`document.querySelector('#btn')`)
    const btn = await measure(btnId)
    await clickAt(btn.x, btn.y)
    const clickLog = await evaluate('window.__log')
    const clickTypes = clickLog.map((entry) => entry.type)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      assert(clickTypes.includes(type), `click sequence missing ${type}: ${clickTypes.join(',')}`)
      assert(clickLog.find((entry) => entry.type === type)?.trusted === true, `${type} was not trusted`)
    }
    log(`click ok: ${clickTypes.join(' → ')} (all trusted)`)

    // 2) Real wheel scroll ----------------------------------------------------
    const scrollerId = await objectIdFor(`document.querySelector('#scroller')`)
    const scroller = await measure(scrollerId)
    await sleep(80)
    // A hidden window's compositor needs a fresh frame before the first wheel
    // (otherwise the wheel is queued and applied late). A 1px capture is the
    // cheap way to force it — the same trick the real implementation uses.
    await wc.capturePage({ x: 0, y: 0, width: 1, height: 1 })
    await mouse('mouseMoved', scroller.x, scroller.y, { button: 'none', buttons: 0 })
    await sleep(50)
    await mouse('mouseWheel', scroller.x, scroller.y, { button: 'none', buttons: 0, deltaX: 0, deltaY: 400 })
    await sleep(250)
    const scrollTop = await evaluate(`document.querySelector('#scroller').scrollTop`)
    if (!(scrollTop > 0)) {
      const diag = await evaluate(`(() => {
        const s = document.querySelector('#scroller');
        const before = s.scrollTop;
        s.scrollBy(0, 100);
        const afterManual = s.scrollTop;
        s.scrollTop = before;
        return {
          pageY: window.scrollY,
          wheel: window.__wheel,
          hit: (document.elementFromPoint(${scroller.x}, ${scroller.y}) || {}).outerHTML,
          rect: (() => { const r = s.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })(),
          scrollHeight: s.scrollHeight,
          clientHeight: s.clientHeight,
          overflowY: getComputedStyle(s).overflowY,
          afterManual,
        };
      })()`)
      throw new Error(`wheel did not scroll (scrollTop=${scrollTop}, target=${JSON.stringify(scroller)}, page=${JSON.stringify(diag)})`)
    }
    log(`scroll ok: scrollTop=${scrollTop}`)

    // 3) Real drag ------------------------------------------------------------
    const boxId = await objectIdFor(`document.querySelector('#box')`)
    const box = await measure(boxId)
    await mouse('mouseMoved', box.x, box.y, { button: 'none', buttons: 0 })
    await mouse('mousePressed', box.x, box.y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(50)
    for (let i = 1; i <= 10; i += 1) {
      await mouse('mouseMoved', box.x + 12 * i, box.y + 6 * i, { button: 'left', buttons: 1 })
      await sleep(16)
    }
    await mouse('mouseReleased', box.x + 120, box.y + 60, { button: 'left', buttons: 0, clickCount: 1 })
    await sleep(80)
    const drag = await evaluate('window.__drag')
    assert(drag.moves > 3, `drag produced too few moves (${drag.moves})`)
    assert(drag.lastX >= box.x + 100, `drag ended at ${drag.lastX}, expected >= ${box.x + 100}`)
    log(`drag ok: ${drag.moves} moves, ended (${Math.round(drag.lastX)}, ${Math.round(drag.lastY)})`)

    // 4) Real text insertion --------------------------------------------------
    const fieldId = await objectIdFor(`document.querySelector('#field')`)
    await cdp('Runtime.callFunctionOn', {
      objectId: fieldId,
      functionDeclaration: `function () { this.scrollIntoView({ block: 'center' }); this.focus(); this.select(); return 'ok' }`,
      returnByValue: true,
    })
    await cdp('Input.insertText', { text: 'hello@example.com' })
    await sleep(80)
    const fieldValue = await evaluate(`document.querySelector('#field').value`)
    const inputEvent = await evaluate(`window.__log.filter((e) => e.type === 'input').pop()`)
    assert(fieldValue === 'hello@example.com', `field value=${fieldValue}`)
    assert(inputEvent?.trusted === true, 'input event was not trusted')
    log(`type ok: value=${fieldValue}, input trusted=${inputEvent.trusted}`)

    // 5) Real key press: Enter submits the form ------------------------------
    const formFieldId = await objectIdFor(`document.querySelector('#formfield')`)
    await cdp('Runtime.callFunctionOn', {
      objectId: formFieldId,
      functionDeclaration: `function () { this.focus(); return 'ok' }`,
      returnByValue: true,
    })
    const enter = { modifiers: 0, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter })
    await cdp('Input.dispatchKeyEvent', { type: 'char', ...enter, text: '\r', unmodifiedText: '\r' })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
    await sleep(120)
    const submitted = await evaluate('window.__submitted === true')
    const keys = await evaluate('window.__keys')
    assert(keys.some((entry) => entry.key === 'Enter' && entry.trusted === true), 'Enter keydown was not trusted')
    assert(submitted === true, 'Enter did not trigger the form default action')
    log(`press ok: trusted Enter keydown, form submitted`)

    // 6) Same-origin iframe coordinate translation ---------------------------
    // Resolve the inner button through its frame's document so callFunctionOn
    // runs in the iframe's own JS context (a cross-realm objectId would leave
    // window.frameElement inaccessible and silently skip the offset).
    const frameElId = await objectIdFor(`document.querySelector('#frame')`)
    const frameNode = await cdp('DOM.describeNode', { objectId: frameElId })
    const contentDocument = frameNode?.node?.contentDocument
    assert(contentDocument?.backendNodeId, 'iframe contentDocument is missing')
    const resolvedDoc = await cdp('DOM.resolveNode', { backendNodeId: contentDocument.backendNodeId })
    const docObjectId = resolvedDoc?.object?.objectId
    assert(docObjectId, 'iframe document did not resolve')
    const queried = await cdp('Runtime.callFunctionOn', {
      objectId: docObjectId,
      functionDeclaration: `function () { return this.querySelector('#inner') }`,
      returnByValue: false,
    })
    const innerId = queried?.result?.objectId
    assert(innerId, 'inner button not found through the frame document')
    const measuredInner = await cdp('Runtime.callFunctionOn', {
      objectId: innerId,
      functionDeclaration: `function () {
        try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) {}
        const r = this.getBoundingClientRect();
        let x = r.left + r.width / 2, y = r.top + r.height / 2;
        let w = window;
        for (let depth = 0; depth < 8; depth += 1) {
          let fe = null;
          try { fe = w.frameElement } catch (e) { fe = null; }
          if (!fe) {
            let isTop = false;
            try { isTop = w.parent === w } catch (e) { isTop = false; }
            if (!isTop) return JSON.stringify({ ok: false, error: 'cross-origin' });
            break;
          }
          const cs = getComputedStyle(fe);
          if (cs.transform && cs.transform !== 'none') return JSON.stringify({ ok: false, error: 'transform' });
          const fr = fe.getBoundingClientRect();
          const ow = fe.offsetWidth || fr.width || 1;
          const oh = fe.offsetHeight || fr.height || 1;
          if (Math.abs(fr.width / ow - 1) > 0.01 || Math.abs(fr.height / oh - 1) > 0.01) {
            return JSON.stringify({ ok: false, error: 'scaled' });
          }
          x += fr.left + (fe.clientLeft || 0) + (parseFloat(cs.paddingLeft) || 0);
          y += fr.top + (fe.clientTop || 0) + (parseFloat(cs.paddingTop) || 0);
          const next = fe.ownerDocument && fe.ownerDocument.defaultView;
          if (!next) break;
          w = next;
        }
        return JSON.stringify({ ok: true, x: x, y: y, localX: r.left + r.width / 2, localY: r.top + r.height / 2 });
      }`,
      returnByValue: true,
    })
    const innerPoint = JSON.parse(measuredInner.result.value)
    assert(innerPoint.ok, `iframe measure failed: ${innerPoint.error}`)
    assert(Math.abs(innerPoint.x - innerPoint.localX) > 1, 'iframe offset was not applied')
    await clickAt(innerPoint.x, innerPoint.y)
    const innerClicked = await evaluate('window.__innerClicked === true')
    assert(innerClicked === true, `iframe click missed (point ${innerPoint.x},${innerPoint.y})`)
    log(`iframe ok: local (${Math.round(innerPoint.localX)},${Math.round(innerPoint.localY)}) → viewport (${Math.round(innerPoint.x)},${Math.round(innerPoint.y)}) clicked`)

    log('browser-input-smoke: OK')
  } catch (error) {
    return fail(error?.message ?? String(error))
  } finally {
    flush()
    server.close()
    win.destroy()
    app.exit(0)
  }
})
