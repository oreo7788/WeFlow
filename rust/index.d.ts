// WeFlow Core - Rust Native Module Type Definitions

export interface SystemInfo {
  version: string
  rustVersion: string
  target: string
}

export interface KeyInfo {
  key: Buffer
  algorithm: string
  createdAt?: number
  expiresAt?: number
}

export interface Session {
  id: string
  nickname?: string
  remark?: string
  type: number
  messageCount: number
}

export interface Message {
  id: number
  localId: number
  serverId?: string
  createTime: number
  type: number
  subType: number
  isSender: boolean
  talker: string
  content?: string
  imagePath?: string
  voicePath?: string
  videoPath?: string
  filePath?: string
  status: number
  msgSeq: number
}

export interface Contact {
  username: string
  alias?: string
  nickname?: string
  remark?: string
  avatar?: string
  type: number
  verifyFlag: number
  reserved1?: string
  reserved2?: string
}

export interface DbConfig {
  dbPath: string
  maxConnections?: number
  timeout?: number
}

export interface ExportConfig {
  outputPath: string
  format: ExportFormat
  includeImages: boolean
  includeVideos: boolean
  maxFileSizeMb?: number
  namingMode: string
}

export enum ExportFormat {
  Html = 0,
  Json = 1,
  Csv = 2,
  Excel = 3,
  Txt = 4,
  ChatLab = 5,
}

export interface ExportProgress {
  stage: string
  total: number
  processed: number
  currentMessage?: string
  error?: string
  startTime: number
  estimatedEndTime?: number
}

export interface ImageDecryptResult {
  success: boolean
  outputPath?: string
  format: string
  error?: string
  isThumbnail: boolean
}

export interface DecryptConfig {
  outputDir: string
  preserveStructure: boolean
  overwrite: boolean
  generateThumbnail: boolean
  quality: number
}

export interface MessageStatsResult {
  totalMessages: number
  totalChars: number
  senderCount: number
  avgMessageLength: number
}

export interface WordStat {
  word: string
  count: number
  rank: number
}

export interface SessionStat {
  name: string
  messageCount: number
  charCount: number
}

export interface YearlyReport {
  year: number
  totalMessages: number
  totalWords: number
  topSessionsJson: string
  topWordsJson: string
  activeHoursJson: string
  activeWeekdaysJson: string
  monthlyDistributionJson: string
  highlightsJson: string
}

export interface Highlight {
  title: string
  description: string
  value?: string
}

export interface InsightMetrics {
  totalMessages: number
  totalDays: number
  totalWords: number
  avgDailyMessages: number
}

export interface DualReport {
  totalMessages: number
  totalDays: number
  totalWords: number
  yearlyWordCount: number
  yearlyMessages: number
  insightMetrics: InsightMetrics
}

export class ImageDecryptService {
  constructor(cacheSize?: number)
  decryptFile(inputPath: string, outputDir: string, config?: DecryptConfig): Promise<ImageDecryptResult>
  decryptBatch(inputPaths: string[], outputDir: string, config?: DecryptConfig, concurrency?: number): Promise<ImageDecryptResult[]>
  clearCache(): number
}

export class KeyService {
  constructor()
  generateXorKey(): Buffer
  deriveKey(password: string, salt?: Buffer): Buffer
  readFromConfig(configPath: string): KeyInfo | null
  exportKey(key: Buffer, path: string, options?: { format?: string; encrypt?: boolean; password?: string }): boolean
  importKey(path: string, password?: string): KeyInfo | null
}

export class WcdbService {
  constructor()
  initialize(config: DbConfig): void
  openAccount(wxid: string, accountPath: string): boolean
  getSessions(wxid: string): string
  getMessages(wxid: string, sessionId: string, limit?: number, offset?: number): string
  searchMessages(wxid: string, keyword: string, limit?: number): string
  getContacts(wxid: string): string
  closeAccount(wxid: string): boolean
}

export class ExportTask {
  constructor(id: string, config: ExportConfig)
  getProgress(): ExportProgress
  execute(messagesJson: string, sessionJson: string): Promise<boolean>
  cancel(): void
  pause(): void
  resume(): void
}

export class ExportService {
  constructor()
  createTask(id: string, config: ExportConfig): ExportTask
  runTask(taskId: string, messagesJson: string, sessionJson: string): Promise<boolean>
  getTaskProgress(taskId: string): ExportProgress | null
  cancelTask(taskId: string): void
  cleanupTasks(): number
}

export class AnalyticsService {
  constructor()
  calculateMessageStats(messagesJson: string): MessageStatsResult
  calculateWordFrequency(messagesJson: string, topN: number): string
  calculateActiveHours(messagesJson: string): string
  generateYearlyReport(messagesJson: string, year: number): YearlyReport
  generateDualReport(messagesJson: string, sessionName: string): DualReport
  clearCache(): number
}

export function version(): string
export function initLogging(): void
export function healthCheck(): Promise<boolean>
export function getSystemInfo(): SystemInfo
export function decryptImageData(data: Buffer, xorKey?: Buffer): Buffer
export function generateImageXorKey(): Buffer
export function generateImageXorKey(md5: string): Buffer
export function deriveDbKey(password: string, salt?: Buffer): Buffer
export function sanitizeTableName(name: string): string
