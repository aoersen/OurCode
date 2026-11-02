/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 上下文用量 UI 的对比度自检（离线，纯 WCAG 公式）。
 *
 * 覆盖 aioli 验收清单里「正文 ≥4.5:1 / 控件 ≥3:1」：直接从 global.css 里读
 * 真实 token（不复制色值，避免自检和实现漂移），把本次新增的状态文本 token
 * 与它们实际所处的背景（白色浮层、页面底色、状态栏半透明底、10% 状态底色）
 * 逐一算出来。
 */
const fs = require('fs')

const CSS = fs.readFileSync('src/styles/global.css', 'utf8')
const lightBlock = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf(':root.dark'))
const darkBlock = CSS.slice(CSS.indexOf(':root.dark'))

function token(block, name) {
  const m = block.match(new RegExp('--' + name.replace(/[-]/g, '\\-') + ':\\s*([^;]+);'))
  if (!m) throw new Error('token not found: ' + name)
  return m[1].trim()
}

const hex = (v) => {
  const h = v.replace('#', '')
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h).slice(0, 6)
}
const srgb = (h) => {
  const v = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = v.map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (fg, bg) => {
  const [a, b] = [srgb(fg), srgb(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}
/** 把 alpha 色叠在不透明底色上，得到实际渲染色 */
const over = (fg, bg, alpha) => {
  const p = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
  const [r1, g1, b1] = p(fg)
  const [r2, g2, b2] = p(bg)
  const mix = (x, y) => Math.round(x * alpha + y * (1 - alpha))
  return '#' + [mix(r1, r2), mix(g1, g2), mix(b1, b2)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

function theme(block) {
  const get = (n) => token(block, n)
  const statusBarRaw = get('bg-statusbar')
  return {
    bg: hex(get('bg')),
    popover: hex(get('surface-popover')),
    primary: hex(get('text-primary')),
    secondary: hex(get('text-secondary')),
    muted: hex(get('text-muted')),
    accent: hex(get('accent').includes('var(') ? get('primary-color') : get('accent')),
    warning: hex(get('warning')),
    warningText: hex(get('warning-text').includes('var(') ? get('warning') : get('warning-text')),
    success: hex(get('success')),
    successText: hex(get('success-text').includes('var(') ? get('success') : get('success-text')),
    error: hex(get('error')),
    errorText: hex(get('error-text').includes('var(') ? get('error') : get('error-text')),
    // 亮色状态栏是半透明白底（叠在页面底色上），暗色是不透明深底
    statusBar: statusBarRaw.startsWith('rgba')
      ? over('#ffffff', hex(get('bg')), Number(statusBarRaw.match(/([0-9.]+)\)$/)[1]))
      : hex(statusBarRaw),
  }
}

const rows = []
const push = (name, label, fg, bg, min) => {
  const r = ratio(fg, bg)
  rows.push({ name, label, ratio: r, min, ok: r >= min })
}

for (const [name, T] of [
  ['light', theme(lightBlock)],
  ['dark', theme(darkBlock)],
]) {
  push(name, '主文案 on 浮层', T.primary, T.popover, 4.5)
  push(name, '次要文案 on 浮层', T.secondary, T.popover, 4.5)
  push(name, '弱化文案 on 浮层', T.muted, T.popover, 4.5)
  push(name, 'warning 文本 on 浮层', T.warningText, T.popover, 4.5)
  push(name, 'success 文本 on 浮层', T.successText, T.popover, 4.5)
  push(name, 'error 文本 on 浮层', T.errorText, T.popover, 4.5)
  push(name, 'warning 文本 on 页面底色', T.warningText, T.bg, 4.5)
  push(name, 'error 文本 on 页面底色', T.errorText, T.bg, 4.5)
  push(name, 'warning 文本 on 状态栏半透明底', T.warningText, T.statusBar, 4.5)
  push(name, 'error 文本 on 状态栏半透明底', T.errorText, T.statusBar, 4.5)
  push(name, 'error 横幅文本 on error 10% 最深处', T.errorText, over(T.error, T.bg, 0.1), 4.5)
  push(name, 'warning 横幅文本 on warning 12% 最深处', T.warningText, over(T.warning, T.bg, 0.12), 4.5)
  push(name, 'success 徽章文本 on success 10% 底', T.successText, over(T.success, T.popover, 0.1), 4.5)
  push(name, 'warning 环形描边 on 状态栏半透明底', T.warningText, T.statusBar, 3)
  push(name, 'error 环形描边 on 浮层', T.error, T.popover, 3)
  push(name, 'accent 环形描边 on 浮层', T.accent, T.popover, 3)
  push(name, '分段条 accent 段 on 浮层', T.accent, T.popover, 3)
  push(name, '分段条 purple 段 on 浮层', hex(token(block(name), 'accent-purple')), T.popover, 3)
  push(name, '分段条 muted 段 on 浮层', T.muted, T.popover, 3)
  push(name, '分段条 warning 段 on 浮层', T.warning, T.popover, 3)
}

function block(name) {
  return name === 'light' ? lightBlock : darkBlock
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
console.log(pad('theme', 6), pad('项', 36), pad('ratio', 7), pad('min', 5), 'result')
for (const r of rows) {
  console.log(pad(r.name, 6), pad(r.label, 36), pad(r.ratio.toFixed(2), 7), pad(r.min, 5), r.ok ? 'PASS' : 'FAIL')
}
const failed = rows.filter((r) => !r.ok)
console.log('\n合计', rows.length, '项，失败', failed.length)
process.exit(failed.length ? 1 : 0)
