/**
 * Target paths of a file-mutating tool call. Every write tool takes a single
 * `path` except `multi_edit_file`, whose paths live in `arguments.edits[]`.
 *
 * Shared by checkpoint capture, the read-before-write guard, the editor
 * reload notification and the 文件改动 panel: each of them used to re-derive
 * the list (or assume `arguments.path`), which is how `multi_edit_file` ended
 * up invisible to the panel and unable to refresh open editors.
 */
export function writeToolPaths(name: string, args?: Record<string, any> | null): string[] {
  if (name === 'multi_edit_file') {
    const edits = Array.isArray(args?.edits) ? args!.edits : []
    const paths = edits.map((edit: any) => pathOf(edit)).filter(Boolean)
    return [...new Set(paths)]
  }
  const single = pathOf(args)
  return single ? [single] : []
}

/** Tools are specified with `path`; the panel has long also accepted the
 *  `filePath` / `target` spellings a model sometimes emits instead. */
function pathOf(args?: Record<string, any> | null): string {
  if (!args) return ''
  for (const key of ['path', 'filePath', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
