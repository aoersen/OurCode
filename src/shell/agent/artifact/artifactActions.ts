/**
 * 产物面板的副作用层：所有「点一下要去改别处状态」的动作集中在这里，
 * 组件只负责画。这样组件保持可读，也避免每个按钮各写一份路径解析。
 *
 * 依赖的都是既有实现，没有新增 IPC：
 *  - 文件写入 diff：editorStore.openDiff（ActiveDiff，见 EditorContainer / FileChangesPanel）
 *  - 回退 / 恢复：chatStore.revertCheckpoint / restoreRevertedPath
 *  - 在编辑器中打开：editorStore.openFile（coreCommands 里没有「打开指定路径」的命令，
 *    只有 openFile/newFile/quickOpen 这类动作，所以走 store 的真实 API；
 *    若将来注册了 `openFileInEditor` 命令，这里会自动优先用它）
 */
import { hasCommand, executeCommand } from '@/services/commands/commandRegistry'
import { useEditorStore } from '@/stores/editorStore'
import type { Checkpoint } from '@/types'
import { relativePathOf } from './artifactModel'

export interface DiskReadResult {
  /** 读到的内容；文件不存在/读不了时为空串 */
  content: string
  /** 文件确实不存在或不可读 */
  missing: boolean
}

/** 读磁盘内容，永不抛。 */
export async function readDiskContent(path: string): Promise<DiskReadResult> {
  try {
    const result = await window.electronAPI.readFile(path)
    return { content: typeof result?.content === 'string' ? result.content : '', missing: false }
  } catch {
    return { content: '', missing: true }
  }
}

/** 「在编辑器中打开」。 */
export function openPathInEditor(path: string): void {
  if (!path) return
  if (hasCommand('openFileInEditor')) {
    executeCommand('openFileInEditor', path)
    return
  }
  void useEditorStore.getState().openFile(path)
}

/** checkpoint 里主展示文件：优先指定路径，其次第一个可快照的文件。 */
export function primaryCheckpointFile(checkpoint: Checkpoint, path?: string) {
  const files = checkpoint.files ?? []
  if (path) {
    const exact = files.find((file) => file.path === path)
    if (exact) return exact
  }
  return files.find((file) => !file.snapshotFailed) ?? files[0]
}

/**
 * 打开某一笔写入的 diff：左侧 = 该 checkpoint 的前像，右侧 = 磁盘当前内容。
 * 所有 checkpoint 路径都是绝对路径（工具参数原样落库），不需要再拼 rootPath。
 */
export async function openCheckpointDiff(checkpoint: Checkpoint, path?: string): Promise<void> {
  const file = primaryCheckpointFile(checkpoint, path)
  if (!file) return

  const editor = useEditorStore.getState()
  const disk = await readDiskContent(file.path)

  const original = file.existed ? file.content : ''
  const notices: string[] = []
  if (file.snapshotFailed) notices.push('这一笔写入前的内容没能拍成快照，左侧仅供参考。')
  if (disk.missing) notices.push('文件已不在磁盘上，右侧为空。')

  editor.openDiff({
    path: file.path,
    fileName: file.path.split(/[\\/]/).pop() || file.path,
    original,
    modified: disk.content,
    language: editor.getLanguageByPath(file.path),
    kind: 'checkpoint',
    checkpointId: checkpoint.id,
    notice: notices.length ? notices.join(' ') : undefined,
  })
}

/**
 * 「对比 HEAD」：把某个文件与 HEAD 版本对比。
 * 左侧取 `git show HEAD:<相对路径>`，右侧取磁盘内容；不在仓库里 / 新建文件时
 * 左侧为空并给一行说明，而不是弹一个错误。
 */
export async function compareWithHead(path: string, projectPath: string | null, fileName?: string): Promise<void> {
  const editor = useEditorStore.getState()
  const label = fileName || path.split(/[\\/]/).pop() || path
  const disk = await readDiskContent(path)

  let original = ''
  let notice: string | undefined

  const relPath = relativePathOf(path, projectPath)
  if (!projectPath || relPath === null) {
    notice = '该文件不在当前项目内，无法与 HEAD 对比；左侧为空。'
  } else {
    try {
      const result = await window.electronAPI.gitExec(projectPath, ['show', `HEAD:${relPath}`])
      if (result?.success && typeof result.output === 'string') {
        original = result.output
      } else {
        notice = 'HEAD 中没有该文件（本次运行新建），左侧为空。'
      }
    } catch {
      notice = '读取 HEAD 版本失败；左侧为空。'
    }
  }

  editor.openDiff({
    path,
    fileName: label,
    original,
    modified: disk.content,
    language: editor.getLanguageByPath(path),
    kind: 'git',
    notice,
  })
}
