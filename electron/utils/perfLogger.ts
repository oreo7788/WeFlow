import { fileLogService } from './fileLogService'

type PerfFieldValue = string | number | boolean | null | undefined
type PerfFields = Record<string, PerfFieldValue>

const DEFAULT_SLOW_THRESHOLD_MS = 100

export function isPerfRecordingEnabled(): boolean {
  return process.env.NODE_ENV === 'development' ||
    process.env.WEFLOW_PERF_LOG === '1' ||
    process.env.WCDB_LOG_ENABLED === '1'
}

function isPerfConsoleEnabled(): boolean {
  return isPerfRecordingEnabled()
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
  if (!isPerfRecordingEnabled()) return

  const line = formatPerfLine(area, action, durationMs, fields)
  fileLogService.write('perf', line, { force: true })

  if (durationMs >= slowThresholdMs) {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export function nowMs(): number {
  return Date.now()
}

export function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}

export interface PerfTimer {
  elapsed(): number
  log(action: string, fields?: PerfFields, slowThresholdMs?: number): void
}

export function startPerfTimer(area: string): PerfTimer {
  const startedAt = nowMs()
  return {
    elapsed: () => nowMs() - startedAt,
    log: (action, fields = {}, slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS) => {
      logPerf(area, action, nowMs() - startedAt, fields, slowThresholdMs)
    }
  }
}
