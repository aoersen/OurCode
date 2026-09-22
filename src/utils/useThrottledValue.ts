import { useEffect, useRef, useState } from 'react'

/**
 * 高频变更值的渲染节流：leading + trailing。
 *
 * 用于 subagentProgress 这类每秒多次换引用的 store 切片——看板/工位条等监控
 * 类 UI 只需 ~1Hz 的更新粒度，逐次跟帧渲染会让整条面板在任务运行期间持续
 * 重绘（肉眼可见的卡顿）。领先沿立即生效（任务出现/结束不拖尾），窗口内的
 * 后续变更合并到 trailing 沿一次提交。
 */
export function useThrottledValue<T>(value: T, intervalMs = 800): T {
  const [throttled, setThrottled] = useState(value)
  const lastEmitRef = useRef(0)

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastEmitRef.current
    if (elapsed >= intervalMs) {
      lastEmitRef.current = now
      setThrottled(value)
      return
    }
    const timer = window.setTimeout(() => {
      lastEmitRef.current = Date.now()
      setThrottled(value)
    }, intervalMs - elapsed)
    return () => window.clearTimeout(timer)
  }, [value, intervalMs])

  return throttled
}
