import { normalizeExportDateRange, normalizeTimestampSeconds } from '../exportServiceUtils'
import * as path from 'path'

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function formatDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDayKey(day: string): Date | null {
  if (!DAY_KEY_PATTERN.test(day)) return null
  const [yearText, monthText, dayText] = day.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const dayOfMonth = Number(dayText)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(dayOfMonth)) return null
  const parsed = new Date(year, month - 1, dayOfMonth, 0, 0, 0, 0)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== dayOfMonth
  ) {
    return null
  }
  return parsed
}

export function startOfDaySeconds(day: string): number {
  const parsed = parseDayKey(day)
  if (!parsed) return 0
  return Math.floor(parsed.getTime() / 1000)
}

export function endOfDaySeconds(day: string): number {
  const parsed = parseDayKey(day)
  if (!parsed) return 0
  parsed.setHours(23, 59, 59, 999)
  return Math.floor(parsed.getTime() / 1000)
}

export function resolveMessageDay(createTimeSec: number): string {
  const normalized = normalizeTimestampSeconds(createTimeSec)
  if (normalized <= 0) return ''
  return formatDayKey(new Date(normalized * 1000))
}

export function enumerateDaysBetween(startSec: number, endSec: number): string[] {
  const start = normalizeTimestampSeconds(startSec)
  const end = normalizeTimestampSeconds(endSec)
  if (start <= 0 || end <= 0) return []

  const startDate = new Date(start * 1000)
  startDate.setHours(0, 0, 0, 0)
  const endDate = new Date(end * 1000)
  endDate.setHours(0, 0, 0, 0)

  const days: string[] = []
  const cursor = new Date(startDate)
  while (cursor.getTime() <= endDate.getTime()) {
    days.push(formatDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function resolveTargetDaysFromDateRange(
  dateRange?: { start: number; end: number } | null
): string[] {
  const normalized = normalizeExportDateRange(dateRange)
  if (!normalized) return []
  return enumerateDaysBetween(normalized.start, normalized.end)
}

export function resolveTargetDays(
  options: {
    dateRange?: { start: number; end: number } | null
    targetDays?: string[]
  },
  allSessionDays?: string[]
): string[] {
  if (Array.isArray(options.targetDays) && options.targetDays.length > 0) {
    return Array.from(new Set(options.targetDays.filter(day => DAY_KEY_PATTERN.test(day)))).sort()
  }

  const fromRange = resolveTargetDaysFromDateRange(options.dateRange)
  if (fromRange.length > 0) {
    return fromRange
  }

  if (Array.isArray(allSessionDays) && allSessionDays.length > 0) {
    return Array.from(new Set(allSessionDays.filter(day => DAY_KEY_PATTERN.test(day)))).sort()
  }

  return []
}

export function sortDayKeys(days: string[]): string[] {
  return Array.from(new Set(days.filter(day => DAY_KEY_PATTERN.test(day)))).sort()
}

export function summarizeManifestDays(days: Record<string, { messageCount?: number }>): {
  firstDay: string | null
  lastDay: string | null
  totalMessageCount: number
} {
  const keys = sortDayKeys(Object.keys(days))
  let totalMessageCount = 0
  for (const day of keys) {
    totalMessageCount += Math.max(0, Math.floor(Number(days[day]?.messageCount || 0)))
  }
  return {
    firstDay: keys[0] ?? null,
    lastDay: keys[keys.length - 1] ?? null,
    totalMessageCount
  }
}

export function resolveDayHtmlRelativePath(day: string): string {
  const parsed = parseDayKey(day)
  if (!parsed) return path.posix.join('days', `${day}.html`)
  const y = parsed.getFullYear()
  const m = `${parsed.getMonth() + 1}`.padStart(2, '0')
  return path.posix.join('days', String(y), m, `${day}.html`)
}

export function resolveDayHtmlAbsolutePath(sessionDir: string, day: string, htmlPath?: string): string {
  const normalizedPath = String(htmlPath || resolveDayHtmlRelativePath(day)).replace(/^[/\\]+/, '')
  return path.join(sessionDir, normalizedPath)
}

export function resolvePathPrefixToSessionRoot(sessionDir: string, fromFilePath: string): string {
  const relativeDepth = path.relative(sessionDir, path.dirname(fromFilePath))
    .split(path.sep)
    .filter(Boolean).length
  return relativeDepth > 0 ? '../'.repeat(relativeDepth) : ''
}

export function resolveDayMonthKey(day: string): string {
  const parsed = parseDayKey(day)
  if (!parsed) return day.slice(0, 7)
  const y = parsed.getFullYear()
  const m = `${parsed.getMonth() + 1}`.padStart(2, '0')
  return `${y}-${m}`
}

export function groupDayKeysByMonth(days: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const day of sortDayKeys(days)) {
    const monthKey = resolveDayMonthKey(day)
    if (!grouped[monthKey]) grouped[monthKey] = []
    grouped[monthKey].push(day)
  }
  return grouped
}
