/**
 * 输入法（IME）组合输入期间的事件判断。
 *
 * 组合期间（拼音/五笔候选词未确认时）按 Enter 是「确认候选词」，不是提交/执行。
 * Chromium 下组合期间的 keydown 事件 `nativeEvent.isComposing === true`
 * （老版本为 keyCode === 229）。所有把 Enter 当作动作的输入框都必须先过这道门，
 * 否则中文用户确认候选词的瞬间就会误触发发送消息/打开文件/执行命令。
 */
export function isComposingEvent(e: KeyboardEvent | { nativeEvent?: KeyboardEvent | null }): boolean {
  const native = (e as { nativeEvent?: KeyboardEvent }).nativeEvent ?? (e as KeyboardEvent)
  return !!native.isComposing || native.keyCode === 229
}
