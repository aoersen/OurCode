/**
 * 3D 办公室 · 场景宿主（vendored office-v3）
 *
 * 把 office-v3 的 OfficeScene 封装为 IDE 可挂载/卸载的宿主：
 * - 默认配置：阴影关 / 帧缓冲上限 1K(1920×1080) / 帧率上限 25 FPS
 * - 软渲环境自动进兼容模式（像素比 1、阴影强制关）
 * - 暴露场景驱动的精简方法集（不再走 iframe/postMessage，直接调用）
 */
import { OfficeScene } from './scene/OfficeScene.js'

export interface OfficeSceneHost {
  setAgentStatus(id: number, status: string): void
  /** 3D 抛物线交接：from 置 transfer 姿态，落桌后 from 回 idle */
  launchTaskTransfer(fromId: number, toId: number, onComplete: () => void): void
  selectAgent(id: number): void
  /** 悬浮标签投影：世界坐标 → 屏幕坐标（每帧可调用，内部复用缓冲） */
  getProjectedAgentPositions(): Array<{ id: number; screenX: number; screenY: number; visible: boolean }>
  /** 视图是否发生变化（相机/尺寸），供标签投影降频 */
  viewDirtyCheck(): boolean
  setRunning(running: boolean): void
  dispose(): void
}

/** 检测软渲环境（SwiftShader / llvmpipe / 微软基础渲染器）。 */
function detectSoftwareRenderer(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (!ext) return false
    const name = (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
    return /swiftshader|llvmpipe|software|basic render/i.test(name)
  } catch {
    return false
  }
}

/**
 * 创建场景宿主。container 必须已有布局尺寸（clientWidth/clientHeight > 0）。
 * 取景（推近/裁边）由 OfficeScene.setCameraFraming 按容器宽高比自动处理。
 */
export function createOfficeSceneHost(
  container: HTMLElement,
  opts?: { onSelect?: (id: number) => void },
): OfficeSceneHost {
  const compatMode = detectSoftwareRenderer()

  const scene = new OfficeScene(
    container,
    (agent: { id: number }) => opts?.onSelect?.(agent.id),
    {
      compatMode,
      // 默认 1K 上限（显存封顶）
      maxBufferW: 1920,
      maxBufferH: 1080,
    },
  )

  // 默认配置：阴影关 / 帧率上限 25（软渲兼容模式同样保持 25）
  scene.setShadows(false)
  scene.setTargetFps(25)

  // 高分屏（dpr>1.5）默认渲染倍率 75%：缓冲像素降到 ~1.5× 屏幕，显存更省
  if (window.devicePixelRatio > 1.5) {
    scene.setRenderScale(0.75)
  }

  return {
    setAgentStatus: (id, status) => scene.setAgentStatus(id, status),
    launchTaskTransfer: (fromId, toId, onComplete) => {
      scene.launchTaskTransfer(fromId, toId, () => {
        scene.setAgentStatus(fromId, 'idle')
        onComplete()
      })
    },
    selectAgent: (id) => scene.selectAgent(id),
    getProjectedAgentPositions: () => scene.getProjectedAgentPositions(),
    viewDirtyCheck: () => scene.viewDirtyCheck(),
    setRunning: (running) => scene.setRunning(running),
    dispose: () => scene.dispose(),
  }
}
