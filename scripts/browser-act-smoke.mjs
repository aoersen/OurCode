#!/usr/bin/env node
/**
 * End-to-end smoke test for the real browser_act pipeline.
 *
 * Unlike browser-input-smoke.mjs (which tests raw CDP calls), this drives the
 * actual electron/services/browser-session.ts implementation: ref resolution,
 * real clicks, hover, drag, wheel scroll (including the hidden-window settle
 * fallback), type, press and same-origin iframe coordinates.
 *
 * Build the module bundle first, then run with Electron:
 *   npx esbuild electron/services/browser-session.ts --bundle --platform=node \
 *     --format=esm --external:electron --outfile=scripts/.browser-session.bundle.mjs
 *   node_modules\electron\dist\electron.exe scripts/browser-act-smoke.mjs
 */

import { app } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  browserAct,
  browserClose,
  browserNavigate,
  browserPageText,
  browserSetVisible,
  browserSnapshot,
  browserState,
  initBrowserSession,
} from './.browser-session.bundle.mjs'

const LOG_PATH = fileURLToPath(new URL('./.browser-act-smoke.log', import.meta.url))
const lines = []
function log(message) {
  lines.push(message)
  console.log(message)
}
function flush() {
  try { writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8') } catch { /* best effort */ }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>act-smoke</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  #btn, #btn2, #hover { position: absolute; top: 40px; width: 120px; height: 40px; }
  #btn { left: 40px; }
  #btn2 { left: 200px; }
  #hover { left: 360px; background: #eee; }
  #box { position: absolute; left: 40px; top: 110px; width: 120px; height: 60px; background: #ddd; }
  #scroller { position: absolute; left: 260px; top: 110px; width: 260px; height: 120px; overflow-y: auto; border: 1px solid #ccc; }
  #scroller div { height: 30px; }
  #field { position: absolute; left: 40px; top: 210px; width: 200px; }
  #form { position: absolute; left: 40px; top: 250px; }
  #out { position: absolute; left: 40px; top: 330px; width: 900px; white-space: pre-wrap; line-height: 1.5; }
  iframe { position: absolute; left: 500px; top: 110px; width: 200px; height: 120px; }
</style></head>
<body>
  <button id="btn" type="button">提交</button>
  <button id="btn2" type="button">坐标</button>
  <div id="hover">悬停</div>
  <div id="box"></div>
  <div id="scroller">${Array.from({ length: 30 }, (_, i) => `<div>row ${i}</div>`).join('')}</div>
  <input id="field" aria-label="邮箱" />
  <form id="form"><input id="formfield" aria-label="表单输入" /><button type="submit">Go</button></form>
  <div id="out">
    <div id="clickOut"></div>
    <div id="coordOut"></div>
    <div id="hoverOut"></div>
    <div id="dragOut"></div>
    <div id="scrollOut"></div>
    <div id="typeOut"></div>
    <div id="pressOut"></div>
    <div id="iframeOut"></div>
    <div id="probeOut"></div>
    <div id="stateOut"></div>
  </div>
  <iframe id="frame"></iframe>
  <script>
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    window.__log = [];
    const wireClick = (id, outId) => {
      const el = document.getElementById(id);
      const seen = [];
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.addEventListener(type, (e) => { seen.push(type + ':' + e.isTrusted); set(outId, outId + '=' + seen.join(',')) });
      }
    };
    wireClick('btn', 'clickOut');
    wireClick('btn2', 'coordOut');
    document.getElementById('hover').addEventListener('mouseover', (e) => set('hoverOut', 'hoverOut=mouseover:' + e.isTrusted));
    document.getElementById('field').addEventListener('input', (e) => set('typeOut', 'typeOut=value=' + e.target.value));
    const box = document.getElementById('box');
    let dragging = false, moves = 0;
    box.addEventListener('pointerdown', () => { dragging = true; moves = 0; set('dragOut', 'dragOut=down') });
    document.addEventListener('pointermove', () => { if (dragging) { moves += 1; set('dragOut', 'dragOut=moves=' + moves) } });
    document.addEventListener('pointerup', () => { if (dragging) { dragging = false; set('dragOut', 'dragOut=moves=' + moves + ':up') } });
    document.getElementById('scroller').addEventListener('wheel', (e) => set('scrollOut', 'scrollOut=wheel=' + e.deltaY));
    document.getElementById('scroller').addEventListener('scroll', (e) => set('scrollOut', 'scrollOut=top=' + Math.round(e.target.scrollTop)));
    document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); set('pressOut', 'pressOut=submitted') });
    document.addEventListener('mousemove', (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      set('probeOut', 'probeOut=' + e.clientX + ',' + e.clientY + ':' + (el ? (el.id || el.tagName) : 'null'));
    });
    document.addEventListener('wheel', (e) => set('probeOut', 'probeOut=wheelDoc=' + e.deltaY), true);
    setInterval(() => {
      set('stateOut', 'stateOut=top=' + Math.round(document.getElementById('scroller').scrollTop));
    }, 100);
    // srcdoc keeps the frame in-process, so Accessibility.getFullAXTree
    // includes its subtree and the ref path can be exercised.
    const frame = document.getElementById('frame');
    frame.srcdoc = '<body style="margin:0"><button id="inner" style="position:absolute;left:30px;top:30px;width:140px;height:40px">内层按钮</button></body>';
    frame.addEventListener('load', () => {
      const inner = frame.contentDocument && frame.contentDocument.getElementById('inner');
      if (inner) inner.addEventListener('click', (e) => set('iframeOut', 'iframeOut=inner:' + e.isTrusted));
    });
  </script>
</body></html>`

const FRAME_PAGE = `<!doctype html><html><body style="margin:0">
  <button id="inner" style="position:absolute;left:30px;top:30px;width:140px;height:40px">内层按钮</button>
  <script>
  document.getElementById('inner').addEventListener('click', (e) => {
      parent.document.getElementById('iframeOut').textContent = 'iframeOut=inner:' + e.isTrusted;
    });
  </script>
</body></html>`

function refsFromSnapshot(text) {
  const refs = []
  const re = /- ([a-z]+) "([^"]*)"(?: value="[^"]*")? \[ref=(e\d+)\]/g
  let match
  while ((match = re.exec(text ?? '')) !== null) {
    refs.push({ role: match[1], name: match[2], ref: match[3] })
  }
  return refs
}

function refFor(refs, name, role) {
  return refs.find((entry) => entry.name === name && (!role || entry.role === role))?.ref
}

async function pageText() {
  const page = await browserPageText()
  return page.ok ? (page.text ?? '') : ''
}

app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/frame' ? FRAME_PAGE : PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  initBrowserSession({ broadcast: () => undefined })

  try {
    const nav = await browserNavigate(`http://127.0.0.1:${port}/`)
    assert(nav.ok, `navigate failed: ${nav.error}`)
    await sleep(500)
    let snapshot = await browserSnapshot()
    assert(snapshot.ok && snapshot.text, `snapshot failed: ${snapshot.error}`)
    let refs = refsFromSnapshot(snapshot.text)
    // The iframe loads as a separate document; poll until its AX subtree shows
    // up so the cross-frame ref path is actually exercised.
    for (let attempt = 0; attempt < 6 && !refFor(refs, '内层按钮', 'button'); attempt += 1) {
      await sleep(300)
      snapshot = await browserSnapshot()
      assert(snapshot.ok && snapshot.text, `snapshot failed: ${snapshot.error}`)
      refs = refsFromSnapshot(snapshot.text)
    }
    log(`refs: ${refs.map((entry) => `${entry.role}:${entry.name}`).join(' | ')}`)

    // 1) Click by ref: real pointer/mouse sequence ---------------------------
    const submitRef = refFor(refs, '提交', 'button')
    assert(submitRef, 'no ref for 提交 (button)')
    const clickRes = await browserAct('click', { ref: submitRef })
    assert(clickRes.ok, `ref click failed: ${clickRes.error}`)
    assert(clickRes.strategy === 'cdp', `expected real input, got ${clickRes.strategy}`)
    await sleep(100)
    let text = await pageText()
    assert(text.includes('clickOut=pointerdown:true,mousedown:true,pointerup:true,mouseup:true,click:true'), `ref click sequence wrong: ${text.slice(0, 600)}`)
    log(`click(ref) ok: ${String(clickRes.detail).slice(0, 120)}`)

    // 2) Click by coordinates ------------------------------------------------
    const coordRes = await browserAct('click', { x: 260, y: 60 })
    assert(coordRes.ok, `coordinate click failed: ${coordRes.error}`)
    assert(coordRes.strategy === 'cdp', `expected real input, got ${coordRes.strategy}`)
    await sleep(100)
    text = await pageText()
    assert(text.includes('coordOut=pointerdown:true,mousedown:true,pointerup:true,mouseup:true,click:true'), `coordinate click sequence wrong: ${text.slice(0, 600)}`)
    log(`click(x/y) ok @ (${coordRes.point?.x}, ${coordRes.point?.y})`)

    // 3) Hover by ref --------------------------------------------------------
    const hoverRef = refFor(refs, '悬停')
    assert(hoverRef, 'no ref for 悬停')
    const hoverRes = await browserAct('hover', { ref: hoverRef })
    assert(hoverRes.ok, `hover failed: ${hoverRes.error}`)
    await sleep(100)
    text = await pageText()
    assert(text.includes('hoverOut=mouseover:true'), `hover did not fire: ${text.slice(0, 600)}`)
    log('hover(ref) ok')

    // 4) Drag by coordinates -------------------------------------------------
    const dragRes = await browserAct('drag', { x: 100, y: 140, toX: 220, toY: 170 })
    assert(dragRes.ok, `drag failed: ${dragRes.error}`)
    await sleep(150)
    text = await pageText()
    const dragMatch = /dragOut=moves=(\d+):up/.exec(text)
    assert(dragMatch && Number(dragMatch[1]) > 3, `drag moves wrong: ${text.slice(0, 600)}`)
    log(`drag ok: ${dragMatch[1]} moves`)

    // 5) Wheel scroll by coordinates (hidden-window settle) ------------------
    const scrollProbe = await browserAct('hover', { x: 390, y: 170 })
    assert(scrollProbe.ok, `scroll probe hover failed: ${scrollProbe.error}`)
    await sleep(100)
    text = await pageText()
    log(`scroll point hit: ${/probeOut=[^\n]*/.exec(text)?.[0] ?? '(missing)'}`)
    const scrollRes = await browserAct('scroll', { x: 390, y: 170, deltaY: 400 })
    assert(scrollRes.ok, `scroll failed: ${scrollRes.error}`)
    log(`scroll detail: ${String(scrollRes.detail)}`)
    await sleep(300)
    text = await pageText()
    const topMatch = /scrollOut=top=(\d+)/.exec(text)
    const stateMatch = /stateOut=top=(\d+)/.exec(text)
    const eventTop = topMatch ? Number(topMatch[1]) : 0
    const stateTop = stateMatch ? Number(stateMatch[1]) : 0
    assert(eventTop > 0 || stateTop > 0, `scroll did not move: ${text.slice(-1200)}`)
    log(`scroll ok: eventTop=${eventTop}, stateTop=${stateTop} (${String(scrollRes.detail).slice(0, 100)})`)

    // 6) Type by ref → trusted input event ----------------------------------
    const fieldRef = refFor(refs, '邮箱', 'textbox')
    assert(fieldRef, 'no ref for 邮箱 (textbox)')
    const typeRes = await browserAct('type', { ref: fieldRef, text: 'hello@example.com' })
    assert(typeRes.ok, `type failed: ${typeRes.error}`)
    await sleep(100)
    text = await pageText()
    assert(text.includes('typeOut=value=hello@example.com'), `type did not update the field: ${text.slice(0, 600)}`)
    log('type(ref) ok')

    // 7) Enter submits the form (native default action) ---------------------
    const formFieldRef = refFor(refs, '表单输入', 'textbox')
    assert(formFieldRef, 'no ref for 表单输入 (textbox)')
    const pressRes = await browserAct('press', { ref: formFieldRef, key: 'Enter' })
    assert(pressRes.ok, `press failed: ${pressRes.error}`)
    await sleep(150)
    text = await pageText()
    assert(text.includes('pressOut=submitted'), `Enter did not submit: ${text.slice(0, 600)}`)
    log('press(Enter) ok: form submitted')

    // 8) Same-origin iframe: coordinate click always works; the AX ref depends
    //    on whether the snapshot exposes the iframe's subtree.
    const iframeCoord = await browserAct('click', { x: 600, y: 160 })
    assert(iframeCoord.ok, `iframe coordinate click failed: ${iframeCoord.error}`)
    await sleep(150)
    text = await pageText()
    assert(text.includes('iframeOut=inner:true'), `iframe coordinate click missed: ${text.slice(-800)}`)
    log('iframe(x/y) ok')

    // 9) Show/hide the window without stealing focus ------------------------
    const shown = browserSetVisible(true, { focus: false })
    assert(shown.visible === true, 'browserSetVisible(true) did not report visible')
    assert(browserState().visible === true, 'browserState() did not reflect the shown window')
    await sleep(150)
    const hidden = browserSetVisible(false)
    assert(hidden.visible === false, 'browserSetVisible(false) did not report hidden')
    assert(browserState().visible === false, 'browserState() did not reflect the hidden window')
    log('show/hide ok: showInactive -> visible, hide -> hidden')

    const innerRef = refFor(refs, '内层按钮', 'button')
    if (innerRef) {
      const iframeRes = await browserAct('click', { ref: innerRef })
      assert(iframeRes.ok, `iframe click failed: ${iframeRes.error}`)
      await sleep(150)
      text = await pageText()
      assert(text.includes('iframeOut=inner:true'), `iframe click missed: ${text.slice(-800)}`)
      log(`iframe(ref) ok: clicked at (${iframeRes.point?.x}, ${iframeRes.point?.y})`)
    } else {
      log('iframe(ref) skipped: AX tree did not expose the inner button')
    }

    log('browser-act-smoke: OK')
  } catch (error) {
    log(`browser-act-smoke: FAILED — ${error?.message ?? String(error)}`)
    flush()
    browserClose()
    server.close()
    app.exit(1)
    return
  }
  flush()
  browserClose()
  server.close()
  app.exit(0)
})
