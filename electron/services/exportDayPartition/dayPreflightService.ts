import * as fs from 'fs'
import * as path from 'path'
import type { ExportOptions } from '../exportServiceTypes'
import type { ExportWriterHost } from '../exportWriterContext'
import { isManifestOptionsCompatible, readManifest, shouldSkipDayExport } from './dayManifestService'
import { getSessionAllDays, getSessionDayStats } from './dayStatsService'
import { resolveExportBaseDir, resolveSessionExportDir } from './sessionDirResolver'
import { resolveDayHtmlAbsolutePath, resolveTargetDays } from './dayRangeResolver'
import { shouldUseDayPartitionExport } from './dayPartitionExporter'

export interface DayPartitionPreflightSessionSummary {
  sessionId: string
  sessionName: string
  hasManifest: boolean
  optionsMismatch: boolean
  skipDays: number
  rebuildDays: number
  emptyDays: number
  rebuildMessages: number
}

export interface DayPartitionPreflightResult {
  success: boolean
  targetDays: string[]
  totalDaySlots: number
  skipDaySlots: number
  rebuildDaySlots: number
  emptyDaySlots: number
  sessionsWithoutManifest: number
  sessionsWithOptionsMismatch: number
  estimatedSeconds: number
  estimatedMinutesLabel: string
  sessions: DayPartitionPreflightSessionSummary[]
  error?: string
}

function estimateExportSeconds(rebuildDaySlots: number, rebuildMessages: number): number {
  const basePerDay = 8
  const perMessage = 0.04
  return Math.max(15, Math.ceil(rebuildDaySlots * basePerDay + rebuildMessages * perMessage))
}

function formatEstimatedMinutes(seconds: number): string {
  if (seconds < 60) return '约 1 分钟'
  const minutes = Math.ceil(seconds / 60)
  if (minutes <= 8) return `约 ${minutes} 分钟`
  return `约 ${minutes}~${minutes + 2} 分钟`
}

export async function getDayPartitionPreflight(
  host: ExportWriterHost,
  sessionIds: string[],
  outputDir: string,
  options: ExportOptions
): Promise<DayPartitionPreflightResult> {
  if (!shouldUseDayPartitionExport(options)) {
    return {
      success: false,
      targetDays: [],
      totalDaySlots: 0,
      skipDaySlots: 0,
      rebuildDaySlots: 0,
      emptyDaySlots: 0,
      sessionsWithoutManifest: 0,
      sessionsWithOptionsMismatch: 0,
      estimatedSeconds: 0,
      estimatedMinutesLabel: '',
      sessions: [],
      error: '预检仅适用于 HTML 按天分区 + 媒体导出'
    }
  }

  const normalizedSessionIds = Array.from(new Set((sessionIds || []).map(id => String(id || '').trim()).filter(Boolean)))
  if (normalizedSessionIds.length === 0) {
    return {
      success: false,
      targetDays: [],
      totalDaySlots: 0,
      skipDaySlots: 0,
      rebuildDaySlots: 0,
      emptyDaySlots: 0,
      sessionsWithoutManifest: 0,
      sessionsWithOptionsMismatch: 0,
      estimatedSeconds: 0,
      estimatedMinutesLabel: '',
      sessions: [],
      error: '未选择会话'
    }
  }

  const exportBaseDir = resolveExportBaseDir(outputDir, options)
  const allSessionDays = options.dateRange ? [] : undefined
  const targetDays = resolveTargetDays(
    { dateRange: options.dateRange, targetDays: options.targetDays },
    allSessionDays ? [] : undefined
  )

  let resolvedTargetDays = targetDays
  if (resolvedTargetDays.length === 0 && !options.dateRange) {
    const daySet = new Set<string>()
    for (const sessionId of normalizedSessionIds.slice(0, 20)) {
      const days = await getSessionAllDays(sessionId)
      days.forEach(day => daySet.add(day))
    }
    resolvedTargetDays = Array.from(daySet).sort()
  }

  if (resolvedTargetDays.length === 0) {
    return {
      success: false,
      targetDays: [],
      totalDaySlots: 0,
      skipDaySlots: 0,
      rebuildDaySlots: 0,
      emptyDaySlots: 0,
      sessionsWithoutManifest: 0,
      sessionsWithOptionsMismatch: 0,
      estimatedSeconds: 0,
      estimatedMinutesLabel: '',
      sessions: [],
      error: '未解析到目标日期'
    }
  }

  const sessions: DayPartitionPreflightSessionSummary[] = []
  let skipDaySlots = 0
  let rebuildDaySlots = 0
  let emptyDaySlots = 0
  let rebuildMessages = 0
  let sessionsWithoutManifest = 0
  let sessionsWithOptionsMismatch = 0

  for (const sessionId of normalizedSessionIds) {
    const sessionInfo = await host.getContactInfo(sessionId)
    const sessionName = sessionInfo.displayName || sessionId
    const sessionTypePrefix = options.sessionNameWithTypePrefix !== false
      ? await host.getSessionFilePrefix(sessionId)
      : ''
    const sessionDir = resolveSessionExportDir({
      exportBaseDir,
      sessionId,
      displayName: sessionName,
      options,
      sessionTypePrefix
    })

    const manifest = readManifest(sessionDir)
    const hasManifest = Boolean(manifest)
    const optionsMismatch = Boolean(manifest && !isManifestOptionsCompatible(manifest, options))
    if (!hasManifest) sessionsWithoutManifest += 1
    if (optionsMismatch) sessionsWithOptionsMismatch += 1

    let sessionSkip = 0
    let sessionRebuild = 0
    let sessionEmpty = 0
    let sessionRebuildMessages = 0

    for (const day of resolvedTargetDays) {
      const stats = await getSessionDayStats(sessionId, day)
      const existing = manifest?.days?.[day] ?? null
      const htmlPath = resolveDayHtmlAbsolutePath(sessionDir, day, manifest?.days?.[day]?.htmlPath)
      const htmlExists = fs.existsSync(htmlPath)

      if (stats.messageCount <= 0) {
        if (existing || htmlExists) {
          sessionEmpty += 1
          emptyDaySlots += 1
        }
        continue
      }

      if (optionsMismatch || !hasManifest) {
        sessionRebuild += 1
        rebuildDaySlots += 1
        sessionRebuildMessages += stats.messageCount
        rebuildMessages += stats.messageCount
        continue
      }

      const skip = shouldSkipDayExport(existing, stats, {
        skipUnchangedDays: options.skipUnchangedDays !== false,
        validateAllDays: options.validateAllDays === true,
        htmlExists
      })

      if (skip) {
        sessionSkip += 1
        skipDaySlots += 1
      } else {
        sessionRebuild += 1
        rebuildDaySlots += 1
        sessionRebuildMessages += stats.messageCount
        rebuildMessages += stats.messageCount
      }
    }

    sessions.push({
      sessionId,
      sessionName,
      hasManifest,
      optionsMismatch,
      skipDays: sessionSkip,
      rebuildDays: sessionRebuild,
      emptyDays: sessionEmpty,
      rebuildMessages: sessionRebuildMessages
    })
  }

  const totalDaySlots = normalizedSessionIds.length * resolvedTargetDays.length
  const estimatedSeconds = estimateExportSeconds(rebuildDaySlots, rebuildMessages)

  return {
    success: true,
    targetDays: resolvedTargetDays,
    totalDaySlots,
    skipDaySlots,
    rebuildDaySlots,
    emptyDaySlots,
    sessionsWithoutManifest,
    sessionsWithOptionsMismatch,
    estimatedSeconds,
    estimatedMinutesLabel: formatEstimatedMinutes(estimatedSeconds),
    sessions
  }
}
