type PerfFieldValue = string | number | boolean | null | undefined
type PerfFields = Record<string, PerfFieldValue>

const DEFAULT_SLOW_THRESHOLD_MS = 50
const STORAGE_KEY = 'weflow.perfLog'

function isPerfConsoleEnabled(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
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
  if (!isPerfConsoleEnabled()) return

  const line = formatPerfLine(area, action, durationMs, fields)
  if (durationMs >= slowThresholdMs) {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export function nowMs(): number {
  return performance.now()
}

export function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}
