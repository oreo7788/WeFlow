import * as fs from 'fs'
import * as path from 'path'
import type { ExportTaskControl } from '../exportServiceTypes'
import type { ExportWriterHost } from '../exportWriterContext'
import { endOfDaySeconds, resolveDayHtmlRelativePath, startOfDaySeconds } from './dayRangeResolver'

const SEARCH_INDEX_DIR = 'search-index'
const COMBINED_INDEX_FILE = 'search-index.jsonl'

function stripPreviewText(raw: unknown): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export async function writeDaySearchIndex(
  host: ExportWriterHost,
  sessionId: string,
  sessionDir: string,
  day: string,
  control?: ExportTaskControl
): Promise<void> {
  const dayStart = startOfDaySeconds(day)
  const dayEnd = endOfDaySeconds(day)
  if (dayStart <= 0 || dayEnd <= 0) return

  const conn = await host.ensureConnected()
  if (!conn.success || !conn.cleanedWxid) return

  const collectParams = host.resolveCollectParams({ format: 'html' } as any)
  const collected = await host.collectMessages(
    sessionId,
    conn.cleanedWxid,
    { start: dayStart, end: dayEnd },
    undefined,
    'text-fast',
    collectParams.targetMediaTypes,
    control
  )

  const indexDir = path.join(sessionDir, '.weflow', SEARCH_INDEX_DIR)
  fs.mkdirSync(indexDir, { recursive: true })

  const href = resolveDayHtmlRelativePath(day)
  const lines: string[] = []
  for (const row of collected.rows || []) {
    const preview = stripPreviewText(row.parsedContent || row.content || row.rawContent)
    if (!preview) continue
    lines.push(JSON.stringify({
      day,
      href,
      t: Number(row.createTime || 0),
      preview
    }))
  }

  fs.writeFileSync(path.join(indexDir, `${day}.jsonl`), lines.join('\n'), 'utf-8')
}

export function rebuildCombinedSearchIndex(sessionDir: string): void {
  const indexDir = path.join(sessionDir, '.weflow', SEARCH_INDEX_DIR)
  const outPath = path.join(sessionDir, '.weflow', COMBINED_INDEX_FILE)
  if (!fs.existsSync(indexDir)) {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    return
  }

  const merged: string[] = []
  const files = fs.readdirSync(indexDir).filter(name => name.endsWith('.jsonl')).sort()
  for (const fileName of files) {
    const content = fs.readFileSync(path.join(indexDir, fileName), 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) merged.push(trimmed)
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, merged.join('\n'), 'utf-8')
}
