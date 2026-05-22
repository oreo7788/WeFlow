import type { BackgroundTaskRecord } from '../types/backgroundTask'

export type ExportTaskStatus =
  | 'queued'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'success'
  | 'error'

export const formatDurationMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  }
  return `${seconds}秒`
}

export const BACKGROUND_TASK_ACTIVE_STATUSES = new Set<BackgroundTaskRecord['status']>([
  'running',
  'pause_requested',
  'paused',
  'cancel_requested'
])

export const EXPORT_TASK_ACTIVE_STATUSES = new Set<ExportTaskStatus>([
  'queued',
  'running',
  'pause_requested',
  'paused',
  'cancel_requested'
])

export const getTaskElapsedMs = (
  startedAt: number,
  finishedAt: number | undefined,
  nowTick: number,
  isActive: boolean
): number => {
  const safeStart = Number.isFinite(startedAt) ? startedAt : nowTick
  const end = isActive ? nowTick : (finishedAt || nowTick)
  return Math.max(0, end - safeStart)
}

export const formatTaskElapsedLabel = (
  startedAt: number,
  finishedAt: number | undefined,
  nowTick: number,
  isActive: boolean
): string => {
  const elapsedMs = getTaskElapsedMs(startedAt, finishedAt, nowTick, isActive)
  return `${isActive ? '已运行' : '耗时'} ${formatDurationMs(elapsedMs)}`
}
