import type { ExportWriterHost } from '../exportWriterContext'
import type { ExportOptions, ExportProgress, ExportTaskControl } from '../exportServiceTypes'
import { countMediaFilesInDayDir, computeDayMediaFingerprint } from './dayMediaExporter'

export interface DayHtmlExportResult {
  success: boolean
  error?: string
  mediaCount: number
  mediaFingerprint: string
}

export async function exportDayHtml(
  host: ExportWriterHost,
  sessionId: string,
  sessionDir: string,
  day: string,
  options: ExportOptions,
  onProgress?: (progress: ExportProgress) => void,
  control?: ExportTaskControl
): Promise<DayHtmlExportResult> {
  const result = await host.exportSessionDayToHtml(
    sessionId,
    sessionDir,
    day,
    options,
    onProgress,
    control
  )

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      mediaCount: 0,
      mediaFingerprint: ''
    }
  }

  const mediaCount = typeof result.mediaCount === 'number'
    ? result.mediaCount
    : countMediaFilesInDayDir(sessionDir, day)

  return {
    success: true,
    mediaCount,
    mediaFingerprint: computeDayMediaFingerprint(sessionDir, day)
  }
}
