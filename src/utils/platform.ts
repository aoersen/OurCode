/**
 * Host-platform helpers for prompt / tool-description text.
 *
 * The preload exposes `process.platform` synchronously — the exact value the
 * main process uses to pick powershell.exe vs bash for run_command — so the
 * renderer can build platform-correct shell guidance without an IPC
 * round-trip. Tests (Node environment, no electron bridge) fall back to the
 * legacy navigator.platform tokens, and to null when neither exists.
 */

export type HostPlatform = 'win32' | 'darwin' | 'linux'

export function hostPlatform(): HostPlatform | null {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) {
    return window.electronAPI.platform
  }
  if (typeof navigator !== 'undefined' && navigator.platform) {
    const platform = String(navigator.platform)
    if (/win/i.test(platform)) return 'win32'
    if (/mac/i.test(platform)) return 'darwin'
    if (/linux/i.test(platform)) return 'linux'
  }
  return null
}

/** One-line shell guidance for the model — the run_command tool description
 *  and the agent-mode instruction share this so neither hardcodes PowerShell. */
export function shellEnvironmentNote(): string {
  switch (hostPlatform()) {
    case 'win32':
      return '当前是 Windows，命令走 PowerShell：没有 grep/&& 等 Unix 命令，赋值用 $env:NAME=... 而不是 set NAME=...，需要搜索用 search_in_files，连续执行分多次调用'
    case 'darwin':
      return '当前是 macOS，命令走 bash：grep、&& 等 Unix 命令可用，需要搜索用 search_in_files，连续执行可串联或分多次调用'
    case 'linux':
      return '当前是 Linux，命令走 bash：grep、&& 等 Unix 命令可用，需要搜索用 search_in_files，连续执行可串联或分多次调用'
    default:
      return '命令在本机默认 shell 执行（Windows 是 PowerShell，macOS/Linux 是 bash），需要搜索用 search_in_files，连续执行分多次调用'
  }
}
