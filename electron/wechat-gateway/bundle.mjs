/**
 * 打包微信网关为单文件（out/wechat-gateway/wechat-gateway.mjs），随应用分发。
 * 以 node20 为目标，便于在 Electron 30（Node 20）下用 ELECTRON_RUN_AS_NODE 运行。
 * 协议层的 openclaw/plugin-sdk/* 依赖由本地 stub 包（sdk-stubs/openclaw-stub，
 * 以 file: 依赖声明在 package.json）满足，esbuild 经 node_modules 正常解析。
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

await build({
  entryPoints: [path.join(root, "electron/wechat-gateway/gateway.mjs")],
  outfile: path.join(root, "out/wechat-gateway/wechat-gateway.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // qrcode-terminal 只在插件 displayQRCode（我们不调用）里动态引入；打包时跳过，
  // 运行期若被意外触发，其内部 try/catch 会兜底降级为打印链接。
  external: ["qrcode-terminal"],
  logLevel: "info",
})
