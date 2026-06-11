import { fileLogService } from './fileLogService'

type PerfFieldValue = string | number | boolean | null | undefined
type PerfFields = Record<string, PerfFieldValue>

const DEFAULT_SLOW_THRESHOLD_MS = 100

function isPerfConsoleEnabled(): boolean {
  return process.env.NODE_ENV === 'development' ||
    process.env.WEFLOW_PERF_LOG === '1' ||
    process.env.WCDB_LOG_ENABLED === '1'
}

function formatFieldValue(value: PerfFieldValue): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'NaN'
  return String(value).replace(/\s+/g, '_')
}

function formatPerfLine(area: string, action: string, durationMs: number, fields: PerfFields = {}): string {
  const parts = [
    '[perf]',
    `area=${area}`,
    `action=${action}`,
    `durationMs=${formatFieldValue(durationMs)}`
  ]

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${formatFieldValue(value)}`)
  }

  return parts.join(' ')
}

export function logPerf(
  area: string,
  action: string,
  durationMs: number,
  fields: PerfFields = {},
  slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS
): void {
  const line = formatPerfLine(area, action, durationMs, fields)
  fileLogService.write('app', line)

  if (!isPerfConsoleEnabled()) return

  if (durationMs >= slowThresholdMs) {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export function nowMs(): number {
  return Date.now()
}
