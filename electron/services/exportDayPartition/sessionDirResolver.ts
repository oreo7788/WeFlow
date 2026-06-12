import * as path from 'path'
import type { ExportOptions } from '../exportServiceTypes'
import { buildSessionExportBaseName } from '../exportServiceUtils'

export function resolveExportBaseDir(outputDir: string, options: ExportOptions): string {
  const writeLayout = String(options.exportWriteLayout || 'B').trim().toUpperCase()
  return writeLayout === 'A' ? path.join(outputDir, 'texts') : outputDir
}

export function resolveSessionExportDir(params: {
  exportBaseDir: string
  sessionId: string
  displayName: string
  options: ExportOptions
  sessionTypePrefix?: string
}): string {
  const { exportBaseDir, sessionId, displayName, options } = params
  const sessionLayout = options.sessionLayout ?? 'shared'
  const useSessionFolder = sessionLayout === 'per-session'
  if (!useSessionFolder) return exportBaseDir

  const safeName = buildSessionExportBaseName(sessionId, displayName, options)
  const sessionNameWithTypePrefix = options.sessionNameWithTypePrefix !== false
  const prefix = sessionNameWithTypePrefix ? String(params.sessionTypePrefix || '') : ''
  const sessionDirName = sessionNameWithTypePrefix ? `${prefix}${safeName}` : safeName
  return path.join(exportBaseDir, sessionDirName)
}
