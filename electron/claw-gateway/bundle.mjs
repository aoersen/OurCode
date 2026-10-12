/**
 * 打包 Claw 渠道网关为单文件（out/claw-gateway/claw-gateway.mjs），随应用分发。
 * 以 node20 为目标，便于在 Electron 30（Node 20）下用 ELECTRON_RUN_AS_NODE 运行。
 *
 * 五个适配器（含官方 SDK：@wecom/aibot-node-sdk、@larksuiteoapi/node-sdk、
 * grammY、ws）都在这一份产物里（esbuild 会把 gateway.mjs 里动态 import 的适配器
 * 内联进同一文件）：主进程按渠道拉起多个进程，靠 CLAW_CHANNEL / CLAW_CONFIG 区分，
 * 因此产物只有一个文件，打包配置不用随渠道增长。
 *
 * 协议层的 openclaw/plugin-sdk/* 依赖由本地 stub 包（sdk-stubs/openclaw-stub，
 * 以 file: 依赖声明在 package.json）满足，esbuild 经 node_modules 正常解析。
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

await build({
  entryPoints: [path.join(root, "electron/claw-gateway/gateway.mjs")],
  outfile: path.join(root, "out/claw-gateway/claw-gateway.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // 产物是 ESM，但依赖树里的官方 SDK（飞书 / 企业微信）与 ws 是 CJS：它们内部会
  // require('events'|'crypto'|'util'|...) 并使用 __dirname。ESM 里这三者都不存在，
  // esbuild 会生成「Dynamic require of X is not supported」「__dirname is not
  // defined」这类运行时错误——而且只在真正去连接时才暴露。banner 把它们补回作用域；
  // 依赖里对 __dirname 的用法只是「找自己的 package.json 读版本号」并带兜底，
  // 因此指向产物目录是安全的。
  banner: {
    js: `import { createRequire as __clawCreateRequire } from 'node:module'
import { fileURLToPath as __clawFileURLToPath } from 'node:url'
import { dirname as __clawDirname } from 'node:path'
const require = __clawCreateRequire(import.meta.url)
const __filename = __clawFileURLToPath(import.meta.url)
const __dirname = __clawDirname(__filename)`,
  },
  // qrcode-terminal 只在插件 displayQRCode（我们不调用）里动态引入；打包时跳过，
  // 运行期若被意外触发，其内部 try/catch 会兜底降级为打印链接。
  external: ["qrcode-terminal"],
  logLevel: "info",
})
