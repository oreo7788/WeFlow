import * as fs from 'fs'
import * as path from 'path'

export const DAY_MEDIA_MAPPING_FILE = 'media-mapping.json'

export interface DayMediaMappingEntry {
  mediaKey: string
  day: string
  type: 'image' | 'video' | 'voice' | 'file' | 'emoji'
  sourceRef: string
  destPath: string
  fileSize: number
  exportedAt: number
}

export interface DayMediaMapping {
  version: 1
  sessionId: string
  entries: Record<string, DayMediaMappingEntry>
}

export function getDayMediaMappingPath(sessionDir: string): string {
  return path.join(sessionDir, '.weflow', DAY_MEDIA_MAPPING_FILE)
}

export function readDayMediaMapping(sessionDir: string, sessionId: string): DayMediaMapping {
  const mappingPath = getDayMediaMappingPath(sessionDir)
  if (!fs.existsSync(mappingPath)) {
    return { version: 1, sessionId, entries: {} }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as DayMediaMapping
    if (!parsed || parsed.sessionId !== sessionId) {
      return { version: 1, sessionId, entries: {} }
    }
    if (!parsed.entries || typeof parsed.entries !== 'object') {
      parsed.entries = {}
    }
    return parsed
  } catch {
    return { version: 1, sessionId, entries: {} }
  }
}

export function writeDayMediaMapping(sessionDir: string, mapping: DayMediaMapping): void {
  const mappingPath = getDayMediaMappingPath(sessionDir)
  fs.mkdirSync(path.dirname(mappingPath), { recursive: true })
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8')
}

export function countMediaFilesInDayDir(_sessionDir: string, _day: string): number {
  // 媒体与会话级 media/ 目录共享，无法按天从目录统计；正常路径由导出增量返回 mediaCount
  return 0
}

export function computeDayMediaFingerprint(_sessionDir: string, _day: string): string {
  // 媒体不再按天分目录，无法从目录生成按天指纹
  return ''
}

export function upsertDayMediaMappingEntry(
  sessionDir: string,
  sessionId: string,
  entry: DayMediaMappingEntry
): void {
  const mapping = readDayMediaMapping(sessionDir, sessionId)
  mapping.entries[entry.mediaKey] = entry
  writeDayMediaMapping(sessionDir, mapping)
}
