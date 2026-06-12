import type { ExportOptions } from '../exportServiceTypes'

export const DAY_PARTITION_SCHEMA = 'weflow-day-partition-v1' as const
export const MANIFEST_VERSION = 1 as const

export type DayRunMode = 'full' | 'day-rebuild' | 'day-skip'
export type DayStatus = 'fresh' | 'stale' | 'failed'

export interface DayManifestEntry {
  day: string
  htmlPath: string
  mediaDir: string
  messageCount: number
  minCreateTime: number
  maxCreateTime: number
  maxLocalId: number
  mediaCount: number
  mediaFingerprint: string
  generatedAt: number
  durationMs: number
  status: DayStatus
  lastRunMode: DayRunMode
}

export interface SessionExportManifest {
  version: typeof MANIFEST_VERSION
  schema: typeof DAY_PARTITION_SCHEMA
  sessionId: string
  sessionName: string
  format: 'html'
  optionsFingerprint: string
  timezone: string
  indexPath: 'index.html'
  indexGeneratedAt: number
  days: Record<string, DayManifestEntry>
  totalMessageCount: number
  totalMediaCount: number
  firstDay: string | null
  lastDay: string | null
  createdAt: number
  updatedAt: number
}

export interface SessionDayStats {
  messageCount: number
  minCreateTime: number
  maxCreateTime: number
  maxLocalId: number
}

export interface DayExportResult {
  day: string
  mode: 'day-skip' | 'day-rebuild'
  messageCount: number
}

export interface DayPartitionProgress {
  phase: 'day-skip' | 'day-rebuild' | 'index-rebuild' | 'complete'
  phaseLabel: string
  currentDay?: string
  daysTotal: number
  daysCompleted: number
  daysSkipped: number
  daysRebuilt: number
}

export type DayPartitionExportOptions = Pick<
  ExportOptions,
  | 'dateRange'
  | 'htmlPartition'
  | 'skipUnchangedDays'
  | 'validateAllDays'
  | 'targetDays'
  | 'exportMedia'
  | 'exportImages'
  | 'exportVoices'
  | 'exportVideos'
  | 'exportEmojis'
  | 'exportFiles'
  | 'exportWriteLayout'
  | 'sessionLayout'
  | 'displayNamePreference'
  | 'exportVoiceAsText'
  | 'maxFileSizeMb'
>
