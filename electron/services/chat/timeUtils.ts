export function normalizeTimestampSeconds(value: number): number {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  let normalized = Math.floor(numeric)
  while (normalized > 10000000000) {
    normalized = Math.floor(normalized / 1000)
  }
  return normalized
}

export function toSafeInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function toSafeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
