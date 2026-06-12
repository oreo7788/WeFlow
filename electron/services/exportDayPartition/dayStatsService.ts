import { wcdbService } from '../wcdbService'
import { normalizeTimestampSeconds } from '../exportServiceUtils'
import type { SessionDayStats } from './dayManifestTypes'
import { endOfDaySeconds, startOfDaySeconds } from './dayRangeResolver'

const EMPTY_DAY_STATS: SessionDayStats = {
  messageCount: 0,
  minCreateTime: 0,
  maxCreateTime: 0,
  maxLocalId: 0
}

function normalizeStatsPayload(data: Record<string, unknown> | undefined): SessionDayStats {
  if (!data) return { ...EMPTY_DAY_STATS }
  return {
    messageCount: Math.max(0, Math.floor(Number(data.total_messages ?? data.totalMessages ?? 0))),
    minCreateTime: Math.max(0, Math.floor(Number(data.first_timestamp ?? data.firstTimestamp ?? 0))),
    maxCreateTime: Math.max(0, Math.floor(Number(data.last_timestamp ?? data.lastTimestamp ?? 0))),
    maxLocalId: Math.max(0, Math.floor(Number(data.max_local_id ?? data.maxLocalId ?? 0)))
  }
}

async function resolveMaxLocalIdFallback(
  sessionId: string,
  maxCreateTime: number,
  dayEnd: number
): Promise<number> {
  if (maxCreateTime <= 0) return 0
  const minTime = Math.max(0, maxCreateTime - 1)
  const limit = 200
  const result = await wcdbService.getNewMessages(sessionId, minTime, limit)
  if (!result.success || !Array.isArray(result.messages)) return 0

  let maxLocalId = 0
  for (const row of result.messages) {
    const createTime = normalizeTimestampSeconds(row.create_time ?? row.createTime ?? row.time)
    if (createTime <= 0 || createTime > dayEnd) continue
    if (createTime < maxCreateTime) continue
    const localId = Math.max(0, Math.floor(Number(row.local_id ?? row.localId ?? 0)))
    if (localId > maxLocalId) {
      maxLocalId = localId
    }
  }
  return maxLocalId
}

export async function getSessionDayStats(
  sessionId: string,
  day: string
): Promise<SessionDayStats> {
  const dayStart = startOfDaySeconds(day)
  const dayEnd = endOfDaySeconds(day)
  if (dayStart <= 0 || dayEnd <= 0) return { ...EMPTY_DAY_STATS }

  const result = await wcdbService.getSessionMessageTypeStats(sessionId, dayStart, dayEnd)
  if (!result.success || !result.data) {
    return { ...EMPTY_DAY_STATS }
  }

  const stats = normalizeStatsPayload(result.data as Record<string, unknown>)
  if (stats.maxLocalId <= 0 && stats.maxCreateTime > 0) {
    stats.maxLocalId = await resolveMaxLocalIdFallback(sessionId, stats.maxCreateTime, dayEnd)
  }
  return stats
}

export async function getSessionAllDays(sessionId: string): Promise<string[]> {
  const result = await wcdbService.getSessionMessageDateCounts(sessionId)
  if (!result.success || !result.counts) return []
  return Object.keys(result.counts).filter(Boolean).sort()
}

export async function getSessionDayStatsBatch(
  sessionId: string,
  days: string[]
): Promise<Record<string, SessionDayStats>> {
  const output: Record<string, SessionDayStats> = {}
  for (const day of days) {
    output[day] = await getSessionDayStats(sessionId, day)
  }
  return output
}
