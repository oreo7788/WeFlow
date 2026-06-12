import * as fs from 'fs'
import * as path from 'path'
import type { ExportWriterHost } from '../exportWriterContext'
import type { ExportOptions, ExportProgress, ExportTaskControl } from '../exportServiceTypes'
import { isPauseError, isStopError } from '../exportServiceUtils'
import {
  applyManifestDayUpdate,
  buildDayManifestEntry,
  buildFailedDayManifestEntry,
  createEmptyManifest,
  isManifestOptionsCompatible,
  markManifestIndexGenerated,
  readManifest,
  shouldSkipDayExport,
  writeManifest
} from './dayManifestService'
import { getSessionAllDays, getSessionDayStats } from './dayStatsService'
import { removeDayHtml } from './dayHtmlStub'
import { exportDayHtml } from './dayHtmlExporter'
import { writeIndexHtml } from './indexHtmlGenerator'
import { resolveDayHtmlAbsolutePath, resolveTargetDays } from './dayRangeResolver'
import { ensureDayPartitionSharedAssets } from './daySharedAssets'
import { rebuildCombinedSearchIndex, writeDaySearchIndex } from './daySearchIndexService'
import { archiveOldMonthPartitions } from './dayArchiveService'
import type { DayExportResult, SessionExportManifest } from './dayManifestTypes'

function throwIfStopRequested(control?: ExportTaskControl): void {
  if (control?.shouldStop?.()) {
    throw new Error('WEFLOW_EXPORT_STOP_REQUESTED')
  }
  if (control?.shouldPause?.()) {
    throw new Error('WEFLOW_EXPORT_PAUSE_REQUESTED')
  }
}

function isDayPartitionEnabled(options: ExportOptions): boolean {
  return options.format === 'html' && options.htmlPartition === 'day' && options.exportMedia === true
}

export function shouldUseDayPartitionExport(options: ExportOptions): boolean {
  return isDayPartitionEnabled(options)
}

function emitDayProgress(
  onProgress: ((progress: ExportProgress) => void) | undefined,
  payload: ExportProgress
): void {
  onProgress?.(payload)
}

export async function exportSessionDayPartition(
  host: ExportWriterHost,
  sessionId: string,
  sessionDir: string,
  sessionName: string,
  options: ExportOptions,
  onProgress?: (progress: ExportProgress) => void,
  control?: ExportTaskControl
): Promise<{ success: boolean; error?: string; indexPath?: string; results?: DayExportResult[] }> {
  if (!isDayPartitionEnabled(options)) {
    return { success: false, error: '按天分区导出需要 HTML 格式并开启媒体导出' }
  }

  const sessionLayout = options.sessionLayout ?? 'shared'
  if (sessionLayout !== 'per-session') {
    return {
      success: false,
      error: '按天分区导出需要使用布局 C（每会话一个目录）'
    }
  }

  try {
    throwIfStopRequested(control)
    host.resetMediaRuntimeState?.()

    const allSessionDays = options.dateRange ? [] : await getSessionAllDays(sessionId)
    const targetDays = resolveTargetDays(
      {
        dateRange: options.dateRange,
        targetDays: options.targetDays
      },
      allSessionDays
    )

    if (targetDays.length === 0) {
      return { success: false, error: '未解析到目标日期，请设置时间范围或确保会话存在历史消息' }
    }

    let manifest = readManifest(sessionDir)
    const isFreshManifest = !manifest
    if (!manifest) {
      manifest = createEmptyManifest({ sessionId, sessionName, options })
    } else if (!isManifestOptionsCompatible(manifest, options)) {
      return {
        success: false,
        error: '导出选项已变更，需全量重建。请清空会话目录或切换回单文件模式后重新导出。'
      }
    }

    fs.mkdirSync(path.join(sessionDir, 'days'), { recursive: true })
    fs.mkdirSync(path.join(sessionDir, 'media'), { recursive: true })
    fs.mkdirSync(path.join(sessionDir, '.weflow'), { recursive: true })
    fs.mkdirSync(path.join(sessionDir, 'assets'), { recursive: true })

    await ensureDayPartitionSharedAssets(sessionDir, () => host.loadExportHtmlStyles())

    const results: DayExportResult[] = []
    let daysSkipped = 0
    let daysRebuilt = 0
    let daysFailed = 0
    const progressTotal = targetDays.length + 1

    for (let index = 0; index < targetDays.length; index += 1) {
      throwIfStopRequested(control)
      const day = targetDays[index]
      const stats = await getSessionDayStats(sessionId, day)
      const existing = manifest.days[day]
      const htmlPath = resolveDayHtmlAbsolutePath(sessionDir, day, existing?.htmlPath)
      const htmlExists = fs.existsSync(htmlPath)

      const skip = existing
        ? shouldSkipDayExport(existing, stats, {
            skipUnchangedDays: options.skipUnchangedDays !== false,
            validateAllDays: options.validateAllDays === true,
            htmlExists
          })
        : false

      if (skip) {
        daysSkipped += 1
        emitDayProgress(onProgress, {
          current: index,
          total: progressTotal,
          currentSession: sessionName,
          currentSessionId: sessionId,
          phase: 'writing',
          phaseLabel: `${day} 无变化，已跳过`,
          phaseProgress: index,
          phaseTotal: progressTotal
        })
        results.push({ day, mode: 'day-skip', messageCount: existing?.messageCount ?? stats.messageCount })
        continue
      }

      emitDayProgress(onProgress, {
        current: index,
        total: progressTotal,
        currentSession: sessionName,
        currentSessionId: sessionId,
        phase: 'exporting',
        phaseLabel: `正在重建 ${day}（${stats.messageCount} 条消息）`,
        phaseProgress: index,
        phaseTotal: progressTotal,
        estimatedTotalMessages: stats.messageCount
      })

      const startedAt = Date.now()
      if (stats.messageCount <= 0) {
        await removeDayHtml(sessionDir, day, existing?.htmlPath)
        manifest = applyManifestDayUpdate(manifest, day, null)
        daysRebuilt += 1
        results.push({ day, mode: 'day-rebuild', messageCount: 0 })
        continue
      }

      const dayResult = await exportDayHtml(
        host,
        sessionId,
        sessionDir,
        day,
        { ...options, targetDays },
        (progress) => {
          emitDayProgress(onProgress, {
            ...progress,
            currentSession: sessionName,
            currentSessionId: sessionId,
            phaseLabel: progress.phaseLabel || `正在重建 ${day}（${stats.messageCount} 条消息）`,
            phaseProgress: index,
            phaseTotal: progressTotal
          })
        },
        control
      )

      if (!dayResult.success) {
        if (isStopError(dayResult.error) || isPauseError(dayResult.error)) {
          return { success: false, error: dayResult.error, results }
        }

        const failedEntry = buildFailedDayManifestEntry({
          day,
          stats,
          existing,
          durationMs: Date.now() - startedAt,
          mode: isFreshManifest ? 'full' : 'day-rebuild'
        })
        manifest = applyManifestDayUpdate(manifest, day, failedEntry)
        daysFailed += 1
        results.push({ day, mode: 'day-rebuild', messageCount: stats.messageCount })
        emitDayProgress(onProgress, {
          current: index,
          total: progressTotal,
          currentSession: sessionName,
          currentSessionId: sessionId,
          phase: 'exporting',
          phaseLabel: `${day} 导出失败，已标记待修复`,
          phaseProgress: index,
          phaseTotal: progressTotal
        })
        continue
      }

      const entry = buildDayManifestEntry({
        day,
        stats,
        generatedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        mode: isFreshManifest ? 'full' : 'day-rebuild',
        mediaCount: dayResult.mediaCount,
        mediaFingerprint: dayResult.mediaFingerprint
      })
      manifest = applyManifestDayUpdate(manifest, day, entry)
      daysRebuilt += 1
      results.push({ day, mode: 'day-rebuild', messageCount: stats.messageCount })
      control?.recordCreatedFile?.(htmlPath)

      try {
        await writeDaySearchIndex(host, sessionId, sessionDir, day, control)
      } catch {
        // 搜索索引失败不阻断导出
      }
    }

    throwIfStopRequested(control)

    emitDayProgress(onProgress, {
      current: targetDays.length,
      total: progressTotal,
      currentSession: sessionName,
      currentSessionId: sessionId,
      phase: 'writing',
      phaseLabel: '正在生成总览页...',
      phaseProgress: targetDays.length,
      phaseTotal: progressTotal
    })

    manifest = markManifestIndexGenerated(manifest)
    rebuildCombinedSearchIndex(sessionDir)
    writeManifest(sessionDir, manifest)
    const indexPath = await writeIndexHtml(sessionDir, manifest)
    control?.recordCreatedFile?.(indexPath)

    if (options.dayArchiveOldMonths === true) {
      try {
        await archiveOldMonthPartitions(sessionDir, manifest, {
          keepRecentMonths: 12,
          excludeDays: targetDays
        })
      } catch {
        // 归档失败不阻断导出
      }
    }

    emitDayProgress(onProgress, {
      current: progressTotal,
      total: progressTotal,
      currentSession: sessionName,
      currentSessionId: sessionId,
      phase: 'complete',
      phaseLabel: daysFailed > 0
        ? `完成（跳过 ${daysSkipped} 天，重建 ${daysRebuilt} 天，失败 ${daysFailed} 天）`
        : `完成（跳过 ${daysSkipped} 天，重建 ${daysRebuilt} 天）`,
      phaseProgress: progressTotal,
      phaseTotal: progressTotal
    })

    return {
      success: true,
      error: daysFailed > 0 ? `${daysFailed} 个日期导出失败，已标记待修复，可勾选「校验并修复」后重试` : undefined,
      indexPath,
      results
    }
  } catch (error) {
    if (isStopError(error)) {
      return { success: false, error: String(error) }
    }
    if (isPauseError(error)) {
      return { success: false, error: String(error) }
    }
    return { success: false, error: String(error) }
  }
}

export type { SessionExportManifest }
