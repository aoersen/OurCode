#!/usr/bin/env node
/**
 * `npm run dev` 的启动包装器（实际执行 electron-vite dev）。
 *
 * 存在的唯一原因：修 Windows 控制台里的中文日志乱码。
 *
 * npm 在 Windows 上通过子 `cmd.exe /d /s /c` 执行 script，而子 cmd 启动时会把
 * **共享控制台**的输出代码页重置为系统 OEM 页（简体中文为 936），退出后也不恢复。
 * 所以 run.bat 顶部的 `chcp 65001` 在 `npx tsc` / `npm run dev` 之后已经失效：
 * Electron 主进程写出的 UTF-8 日志被控制台按 GBK 解码，中文全成乱码，连行尾
 * 换行都会被 GBK 解码器当成非法尾字节吞掉（两条日志粘在一起）。
 *
 * Electron 自己改不回来——Chromium 是 GUI 进程，不挂在启动它的控制台上，它派生
 * 的 chcp 子进程找不到控制台。而本脚本是 npm 脚本跑起来的普通 Node 进程，**与
 * 控制台同挂接**，于是在这里（npm 的 cmd 之后、electron-vite 之前）设代码页是
 * 唯一可靠的位置。
 */
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  // 没有控制台时（CI、后台运行）chcp 会失败，忽略即可。
  spawnSync('chcp.com', ['65001'], { stdio: 'ignore' })
}

const electronViteBin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'electron-vite',
  'bin',
  'electron-vite.js'
)

const child = spawn(process.execPath, [electronViteBin, 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit'
})

child.on('error', (err) => {
  console.error('[dev] 启动 electron-vite 失败：', err)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
