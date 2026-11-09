import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      rollupOptions: {
        external: ['better-sqlite3', 'node-pty'],
        input: {
          main: resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'electron/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist-electron/renderer',
      // Stale hashed chunks used to accumulate across builds (the main/preload
      // outputs live in the same dist-electron root, so only the renderer's own
      // subdirectory is emptied).
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('shared'),
      },
    },
    plugins: [react()],
    server: {
      // 编辑工具（写入 / 重命名）会在同目录塞临时目录与 .tmp 文件；Windows 上
      // Vite 的 fs watcher 一旦 watch 到里头的 .tmp 就抛 EBUSY，把整个 dev server
      // 打死（见 vite.config.preview.ts 里同样的处理）。预览沙盘不需要这些。
      watch: { ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/.*.tmpdir/**'] },
    },
  },
})
