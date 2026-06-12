import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { ExportOptions } from '../exportServiceTypes'
import {
  DAY_PARTITION_SCHEMA,
  MANIFEST_VERSION,
  type DayManifestEntry,
  type DayStatus,
  type SessionDayStats,
  type SessionExportManifest
} from './dayManifestTypes'
import { sortDayKeys, summarizeManifestDays, resolveDayHtmlRelativePath } from './dayRangeResolver'

export const MANIFEST_FILE_NAME = 'manifest.json'

export interface DayNavPayload {
  day: string
  next: string | null
  nextLabel: string | null
  prev: string | null
  index: string
}

export function resolveDayNavPayload(
  sessionDir: string,
  currentDay: string,
  assetPrefix: string,
  dayKeysOverride?: string[]
): DayNavPayload | null {
  const manifest = readManifest(sessionDir)
  const merged = new Set<string>([
    ...Object.keys(manifest?.days || {}),
    ...(dayKeysOverride || [])
  ])
  const dayKeys = sortDayKeys(Array.from(merged))
  if (dayKeys.length === 0) return null

  const idx = dayKeys.indexOf(currentDay)
  if (idx < 0) return null

  const toHref = (day: string | null | undefined): string | null => {
    if (!day) return null
    const htmlPath = manifest?.days?.[day]?.htmlPath || resolveDayHtmlRelativePath(day)
    return `${assetPrefix}${String(htmlPath).replace(/^\/+/, '')}`
  }

  const prevDay = idx > 0 ? dayKeys[idx - 1] : null
  const nextDay = idx < dayKeys.length - 1 ? dayKeys[idx + 1] : null

  return {
    day: currentDay,
    prev: toHref(prevDay),
    next: toHref(nextDay),
    nextLabel: nextDay,
    index: `${assetPrefix}index.html`
  }
}

export function resolveSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function computeOptionsFingerprint(options: ExportOptions): string {
  const payload = {
    htmlPartition: options.htmlPartition ?? 'single',
    exportMedia: options.exportMedia === true,
    exportImages: options.exportImages === true,
    exportVoices: options.exportVoices === true,
    exportVideos: options.exportVideos === true,
    exportEmojis: options.exportEmojis === true,
    exportFiles: options.exportFiles === true,
    exportVoiceAsText: options.exportVoiceAsText === true,
    maxFileSizeMb: options.maxFileSizeMb ?? null,
    exportWriteLayout: options.exportWriteLayout ?? 'B',
    sessionLayout: options.sessionLayout ?? 'shared',
    displayNamePreference: options.displayNamePreference ?? 'remark'
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

export function getManifestPath(sessionDir: string): string {
  return path.join(sessionDir, MANIFEST_FILE_NAME)
}

export function readManifest(sessionDir: string): SessionExportManifest | null {
  const manifestPath = getManifestPath(sessionDir)
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as SessionExportManifest
    if (!parsed || parsed.schema !== DAY_PARTITION_SCHEMA || parsed.version !== MANIFEST_VERSION) {
      return null
    }
    if (!parsed.days || typeof parsed.days !== 'object') {
      parsed.days = {}
    }
    return parsed
  } catch {
    return null
  }
}

export function writeManifest(sessionDir: string, manifest: SessionExportManifest): void {
  fs.mkdirSync(sessionDir, { recursive: true })
  const manifestPath = getManifestPath(sessionDir)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

export function createEmptyManifest(params: {
  sessionId: string
  sessionName: string
  options: ExportOptions
  timezone?: string
}): SessionExportManifest {
  const now = Date.now()
  return {
    version: MANIFEST_VERSION,
    schema: DAY_PARTITION_SCHEMA,
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    format: 'html',
    optionsFingerprint: computeOptionsFingerprint(params.options),
    timezone: params.timezone || resolveSystemTimezone(),
    indexPath: 'index.html',
    indexGeneratedAt: 0,
    days: {},
    totalMessageCount: 0,
    totalMediaCount: 0,
    firstDay: null,
    lastDay: null,
    createdAt: now,
    updatedAt: now
  }
}

export function canSkipDay(
  existing: DayManifestEntry,
  stats: SessionDayStats,
  options?: { skipUnchangedDays?: boolean; validateAllDays?: boolean; htmlExists?: boolean }
): boolean {
  if (options?.skipUnchangedDays === false) return false
  if (existing.status !== 'fresh') return false
  if (options?.htmlExists === false) return false
  return (
    existing.messageCount === stats.messageCount &&
    existing.maxCreateTime >= stats.maxCreateTime &&
    existing.maxLocalId >= stats.maxLocalId
  )
}

export function isDayManifestStale(
  existing: DayManifestEntry,
  stats: SessionDayStats,
  htmlExists: boolean
): boolean {
  if (!htmlExists) return true
  if (existing.status === 'failed' || existing.status === 'stale') return true
  return !(
    existing.messageCount === stats.messageCount &&
    existing.maxCreateTime >= stats.maxCreateTime &&
    existing.maxLocalId >= stats.maxLocalId
  )
}

export function shouldSkipDayExport(
  existing: DayManifestEntry | null | undefined,
  stats: SessionDayStats,
  options?: { skipUnchangedDays?: boolean; validateAllDays?: boolean; htmlExists?: boolean }
): boolean {
  if (options?.skipUnchangedDays === false) return false
  if (!existing) return false
  const htmlExists = options?.htmlExists !== false
  if (!htmlExists) return false

  if (options?.validateAllDays) {
    return !isDayManifestStale(existing, stats, htmlExists)
  }

  return canSkipDay(existing, stats, { ...options, htmlExists })
}

export function buildDayManifestEntry(params: {
  day: string
  stats: SessionDayStats
  generatedAt: number
  durationMs: number
  mode: DayManifestEntry['lastRunMode']
  mediaCount?: number
  mediaFingerprint?: string
  status?: DayStatus
}): DayManifestEntry {
  const { day, stats, generatedAt, durationMs, mode } = params
  return {
    day,
    htmlPath: resolveDayHtmlRelativePath(day),
    mediaDir: 'media',
    messageCount: stats.messageCount,
    minCreateTime: stats.minCreateTime,
    maxCreateTime: stats.maxCreateTime,
    maxLocalId: stats.maxLocalId,
    mediaCount: Math.max(0, Math.floor(Number(params.mediaCount || 0))),
    mediaFingerprint: String(params.mediaFingerprint || ''),
    generatedAt,
    durationMs,
    status: params.status || 'fresh',
    lastRunMode: mode
  }
}

export function buildFailedDayManifestEntry(params: {
  day: string
  stats: SessionDayStats
  existing?: DayManifestEntry | null
  durationMs: number
  mode: DayManifestEntry['lastRunMode']
}): DayManifestEntry {
  const previous = params.existing
  return buildDayManifestEntry({
    day: params.day,
    stats: params.stats,
    generatedAt: Date.now(),
    durationMs: params.durationMs,
    mode: params.mode,
    mediaCount: previous?.mediaCount ?? 0,
    mediaFingerprint: previous?.mediaFingerprint ?? '',
    status: 'failed'
  })
}

export function applyManifestDayUpdate(
  manifest: SessionExportManifest,
  day: string,
  entry: DayManifestEntry | null
): SessionExportManifest {
  const nextDays = { ...manifest.days }
  if (entry) {
    nextDays[day] = entry
  } else {
    delete nextDays[day]
  }

  const summary = summarizeManifestDays(nextDays)
  const totalMediaCount = sortDayKeys(Object.keys(nextDays)).reduce(
    (sum, key) => sum + Math.max(0, Math.floor(Number(nextDays[key]?.mediaCount || 0))),
    0
  )

  return {
    ...manifest,
    days: nextDays,
    totalMessageCount: summary.totalMessageCount,
    totalMediaCount,
    firstDay: summary.firstDay,
    lastDay: summary.lastDay,
    updatedAt: Date.now()
  }
}

export function markManifestIndexGenerated(manifest: SessionExportManifest): SessionExportManifest {
  return {
    ...manifest,
    indexGeneratedAt: Date.now(),
    updatedAt: Date.now()
  }
}

export function isManifestOptionsCompatible(
  manifest: SessionExportManifest,
  options: ExportOptions
): boolean {
  return manifest.optionsFingerprint === computeOptionsFingerprint(options)
}
