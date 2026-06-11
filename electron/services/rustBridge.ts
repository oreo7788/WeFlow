/**
 * Rust Bridge - Electron 与 Rust 核心模块的桥接层
 * 
 * 这个文件提供与现有 TypeScript 服务兼容的接口，
 * 底层调用 Rust 原生模块实现高性能操作。
 */

import { app } from 'electron';
import path from 'path';

// 动态加载 Rust 模块（生产环境使用原生，开发环境可选回退）
let rustModule: any = null;

try {
  // 计算 rust 模块路径
  let rustPath: string;
  if (app.isPackaged) {
    // 生产环境：在 app.asar.unpacked 中
    rustPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'rust');
  } else {
    // 开发环境：从当前文件位置向上查找
    // electron/services/ -> ../../rust 或 dist-electron/services/ -> ../../rust
    rustPath = path.join(__dirname, '..', '..', 'rust');
  }

  // 如果路径不存在，尝试从 cwd 查找
  if (!require('fs').existsSync(rustPath)) {
    const cwdPath = path.join(process.cwd(), 'rust');
    if (require('fs').existsSync(cwdPath)) {
      rustPath = cwdPath;
    }
  }

  rustModule = require(rustPath);
  console.log('[Rust Bridge] 成功加载 Rust 核心模块，路径:', rustPath);
} catch (e) {
  console.warn('[Rust Bridge] 无法加载 Rust 模块，将使用 TypeScript 回退实现:', (e as Error).message);
  rustModule = null;
}

/**
 * 检查 Rust 模块是否可用
 */
export function isRustAvailable(): boolean {
  return rustModule !== null;
}

/**
 * 获取 Rust 版本信息
 */
export function getRustVersion(): { version: string; rustVersion: string; target: string } | null {
  if (!rustModule) return null;
  
  try {
    return rustModule.getSystemInfo();
  } catch (e) {
    console.error('[Rust Bridge] 获取版本信息失败:', e);
    return null;
  }
}

/**
 * 初始化 Rust 日志系统
 */
export function initRustLogging(): void {
  if (rustModule?.initLogging) {
    rustModule.initLogging();
  }
}

// ===== 图片解密服务桥接 =====

export interface RustDecryptResult {
  success: boolean;
  outputPath?: string;
  format: string;
  error?: string;
  isThumbnail: boolean;
}

export class RustImageDecryptService {
  private service: any;

  constructor() {
    if (!rustModule?.ImageDecryptService) {
      throw new Error('Rust 图片解密服务不可用');
    }
    this.service = new rustModule.ImageDecryptService();
  }

  setXorKey(key: Buffer): void {
    this.service.setXorKey(key);
  }

  setAesKey(key: string): void {
    this.service.setAesKey(key);
  }

  async decryptFile(inputPath: string, outputDir: string): Promise<RustDecryptResult> {
    return this.service.decryptFile(inputPath, outputDir);
  }

  async decryptBatch(
    inputPaths: string[], 
    outputDir: string, 
    concurrency: number = 4
  ): Promise<RustDecryptResult[]> {
    return this.service.decryptBatch(inputPaths, outputDir, concurrency);
  }

  async tryDetectKey(samplePath: string): Promise<Buffer | null> {
    return this.service.tryDetectKey(samplePath);
  }
}

// ===== 导出服务桥接 =====

export type RustExportFormat = 'Html' | 'Json' | 'Csv' | 'Excel' | 'Txt' | 'ChatLab';

export interface RustExportConfig {
  format: RustExportFormat;
  outputPath: string;
  includeMedia: boolean;
  includeAvatar?: boolean;
  dateRangeStart?: number;
  dateRangeEnd?: number;
  maxFileSizeMb?: number;
  namingMode?: 'datetime' | 'sequential' | 'original';
}

export interface RustExportProgress {
  total: number;
  current: number;
  percentage: number;
  currentItem?: string;
  stage: 'preparing' | 'exporting' | 'finalizing' | 'completed' | 'error';
  error?: string;
}

export interface RustMessage {
  id: number;
  localId: number;
  serverId?: string;
  createTime: number;
  type: number;
  subType: number;
  isSender: boolean;
  talker: string;
  content?: string;
  imagePath?: string;
  voicePath?: string;
  videoPath?: string;
  filePath?: string;
  status: number;
  msgSeq: number;
}

export interface RustSession {
  id: string;
  nickname?: string;
  remark?: string;
  type: number;
  messageCount: number;
}

export class RustExportService {
  private service: any;

  constructor() {
    if (!rustModule?.ExportService) {
      throw new Error('Rust 导出服务不可用');
    }
    this.service = new rustModule.ExportService();
  }

  createTask(id: string, config: RustExportConfig): RustExportTask {
    const rustConfig = {
      ...config,
      namingMode: config.namingMode || 'datetime',
    };
    const task = this.service.createTask(id, rustConfig);
    return new RustExportTask(task);
  }

  getTaskProgress(taskId: string): RustExportProgress | null {
    return this.service.getTaskProgress(taskId);
  }

  cancelTask(taskId: string): void {
    this.service.cancelTask(taskId);
  }

  cleanupTasks(): number {
    return this.service.cleanupTasks();
  }
}

export class RustExportTask {
  constructor(private task: any) {}

  getProgress(): RustExportProgress {
    return this.task.getProgress();
  }

  async execute(messages: RustMessage[], session: RustSession): Promise<boolean> {
    return this.task.execute(messages, session);
  }

  cancel(): void {
    this.task.cancel();
  }

  pause(): void {
    this.task.pause();
  }

  resume(): void {
    this.task.resume();
  }
}

// ===== 数据分析服务桥接 =====

export interface RustWordStat {
  word: string;
  count: number;
}

export interface RustSessionStat {
  sessionId: string;
  sessionName: string;
  messageCount: number;
  wordCount: number;
}

export interface RustMessageStatsResult {
  totalMessages: number;
  totalChars: number;
  imageCount: number;
  voiceCount: number;
  videoCount: number;
  fileCount: number;
  firstMessageTime?: number;
  lastMessageTime?: number;
  messageTypeDistribution: Record<string, number>;
}

export interface RustYearlyReport {
  year: number;
  totalMessages: number;
  totalWords: number;
  topSessions: RustSessionStat[];
  topWords: RustWordStat[];
  activeHours: number[];
  activeWeekdays: number[];
  monthlyDistribution: Array<{
    month: number;
    messageCount: number;
    wordCount: number;
  }>;
  highlights: Array<{
    title: string;
    description: string;
    value?: string;
  }>;
}

export interface RustDualReport {
  withWhom: string;
  firstChatDate?: string;
  totalDays: number;
  totalMessages: number;
  myMessageCount: number;
  otherMessageCount: number;
  myWordCount: number;
  otherWordCount: number;
  myTopWords: string[];
  otherTopWords: string[];
  commonTopics: string[];
  specialDates: Array<{
    date: string;
    description: string;
    messageCount: number;
  }>;
  chatPatterns: {
    whoStartsMore: string;
    avgReplyTimeSeconds: number;
    longestConversationMessages: number;
    longestGapDays: number;
  };
}

export class RustAnalyticsService {
  private service: any;

  constructor() {
    if (!rustModule?.AnalyticsService) {
      throw new Error('Rust 分析服务不可用');
    }
    this.service = new rustModule.AnalyticsService();
  }

  calculateMessageStats(messages: RustMessage[]): RustMessageStatsResult {
    return this.service.calculateMessageStats(messages);
  }

  calculateWordFrequency(messages: RustMessage[], topN: number = 50): RustWordStat[] {
    return this.service.calculateWordFrequency(messages, topN);
  }

  calculateActiveHours(messages: RustMessage[]): number[] {
    return this.service.calculateActiveHours(messages);
  }

  generateYearlyReport(messages: RustMessage[], year: number): RustYearlyReport {
    return this.service.generateYearlyReport(messages, year);
  }

  generateDualReport(messages: RustMessage[], sessionName: string): RustDualReport {
    return this.service.generateDualReport(messages, sessionName);
  }

  clearCache(): number {
    return this.service.clearCache();
  }
}

// ===== 数据库服务桥接 =====

export interface RustDbConfig {
  dbPath: string;
  key?: string;
  readOnly: boolean;
}

export class RustWcdbService {
  private service: any;

  constructor() {
    if (!rustModule?.WcdbService) {
      throw new Error('Rust WCDB 服务不可用');
    }
    this.service = new rustModule.WcdbService();
  }

  initialize(config: RustDbConfig): void {
    this.service.initialize(config);
  }

  openAccount(wxid: string, accountPath: string): boolean {
    return this.service.openAccount(wxid, accountPath);
  }

  closeAccount(wxid: string): boolean {
    return this.service.closeAccount(wxid);
  }

  query(wxid: string, sql: string): string[] {
    return this.service.query(wxid, sql);
  }

  getSessions(wxid: string): RustSession[] {
    return this.service.getSessions(wxid);
  }

  getMessageCount(wxid: string, sessionId: string): number {
    return this.service.getMessageCount(wxid, sessionId);
  }
}

// ===== 工具函数 =====

/**
 * 解密图片数据（直接操作 Buffer）
 */
export function rustDecryptImageData(data: Buffer, xorKey?: Buffer): Buffer {
  if (!rustModule?.decryptImageData) {
    throw new Error('Rust 解密工具不可用');
  }
  return rustModule.decryptImageData(data, xorKey);
}

/**
 * 生成图片 XOR 密钥
 */
export function rustGenerateImageXorKey(md5: string): Buffer {
  if (!rustModule?.generateImageXorKey) {
    throw new Error('Rust 密钥工具不可用');
  }
  return rustModule.generateImageXorKey(md5);
}

/**
 * 派生数据库密钥
 */
export function rustDeriveDbKey(password: string, salt?: Buffer): Buffer {
  if (!rustModule?.deriveDbKey) {
    throw new Error('Rust 密钥工具不可用');
  }
  return rustModule.deriveDbKey(password, salt);
}

/**
 * 安全化 SQL 表名
 */
export function rustSanitizeTableName(name: string): string {
  if (!rustModule?.sanitizeTableName) {
    // 回退实现
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  return rustModule.sanitizeTableName(name);
}

// ===== 回退实现 =====

/**
 * 如果 Rust 不可用，返回 TypeScript 回退服务
 */
export function getFallbackImageDecryptService(): any {
  // 这里可以返回现有的 imageDecryptService 实例
  console.log('[Rust Bridge] 使用 TypeScript 回退实现');
  return null;
}

export function getFallbackExportService(): any {
  // 这里可以返回现有的 exportService 实例
  console.log('[Rust Bridge] 使用 TypeScript 回退实现');
  return null;
}

export function getFallbackAnalyticsService(): any {
  // 这里可以返回现有的 insightService 实例
  console.log('[Rust Bridge] 使用 TypeScript 回退实现');
  return null;
}

// ===== 便捷导出 =====

export function createRustImageDecryptService(): RustImageDecryptService {
  return new RustImageDecryptService();
}

export function createRustExportService(): RustExportService {
  return new RustExportService();
}

export function createRustAnalyticsService(): RustAnalyticsService {
  return new RustAnalyticsService();
}

export function createRustWcdbService(): RustWcdbService {
  return new RustWcdbService();
}
