import { useEffect, useState, type RefObject } from 'react'

export interface ElementSize {
  width: number
  height: number
}

/**
 * 观测元素的内容盒尺寸（ResizeObserver，1px 去抖）。
 *
 * 用途：分栏高度改像素模型后，需要知道中央列的实际可用高度来算边界；
 * 看板三栏需要在宽度不足时切成纵向堆叠。窗口缩放 / 面板拖拽 / 收起展开
 * 都会触发 observer，不需要额外监听 window.resize。
 *
 * 不支持 ResizeObserver 时回落到 window.resize。
 */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const read = () => {
      const width = Math.round(el.clientWidth)
      const height = Math.round(el.clientHeight)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }

    read()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }

    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}
