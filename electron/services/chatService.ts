import { join } from 'path'
import { existsSync, statSync } from 'fs'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { ConfigService, type ConfigSchema } from './config'
import { resolveAccountDir } from './accountDirResolver'
import { wcdbService } from './wcdbService'
import { MessageCacheService } from './messageCacheService'
import { ContactCacheService, ContactCacheEntry } from './contactCacheService'
import { exportCardDiagnosticsService } from './exportCardDiagnosticsService'
import {
  buildMessageKey,
  coerceRowNumber,
  compareMessagesByTimeline,
  encodeMessageKeySegment,
  getMessageSourceInfo,
  getRowField,
  getRowInt,
  getRowTimestampSeconds,
  normalizeMessageOrder,
  normalizeTimestampLikeToSeconds,
  normalizeUnsignedIntegerToken,
  parseCompactDateTimeDigitsToSeconds,
  parseDateTimeTextToSeconds,
  resolveMessageIsSend
} from './chat/messageRowUtils'
import {
  mapRowsToMessages,
  mapRowsToMessagesLite
} from './chat/messageMapper'
import {
  cleanString,
  cleanUtf16,
  compactEncodedPayload,
  decodeBinaryContent,
  decodeHtmlEntities,
  decodeMaybeCompressed,
  decodeMessageContent,
  extractXmlValue,
  extractSenderUsernameFromContent,
  getMessageTypeLabel,
  looksLikeHex,
  looksLikeBase64,
  parseCardInfo,
  parseEmojiInfo,
  parseImageDatNameFromRow,
  parseMessageContent,
  parseType49Message,
  parseImageInfo,
  parseVideoFileNameFromRow,
  sanitizeQuotedContent,
  stripSenderPrefix
} from './chat/messageParsing'
import { MyFootprintService } from './chat/myFootprintService'
import type { MyFootprintHost } from './chat/myFootprintHost'
import { SessionStatsService } from './chat/sessionStatsService'
import type { SessionStatsHost } from './chat/sessionStatsHost'
import { MediaAssetsService } from './chat/mediaAssetsService'
import type { MediaAssetsHost } from './chat/mediaAssetsHost'
import { MessageCursorService } from './chat/messageCursorService'
import type { MessageCursorHost } from './chat/messageCursorHost'
import { resolveQuotedMessages as resolveQuotedMessagesImpl } from './chat/quoteResolution'
import { ContactsService } from './chat/contactsService'
import type { ContactsHost } from './chat/contactsHost'
import { SessionDetailService } from './chat/sessionDetailService'
import type { SessionDetailHost } from './chat/sessionDetailHost'
import { SessionListService } from './chat/sessionListService'
import type { SessionListHost } from './chat/sessionListHost'
import { AntiRevokeService } from './chat/antiRevokeService'
import type { AntiRevokeHost } from './chat/antiRevokeHost'
import { SessionContactService, isValidAvatarUrl } from './chat/sessionContactService'
import type { SessionContactHost } from './chat/sessionContactHost'
import { EmojiService } from './chat/emojiService'
import type { EmojiHost } from './chat/emojiHost'
import { SessionFilterService } from './chat/sessionFilterService'
import { MessageParseService } from './chat/messageParseService'
import type { MessageParseHost } from './chat/messageParseHost'
import { MessageQueryService } from './chat/messageQueryService'


import type {
  ChatSession,
  Contact,
  ContactInfo,
  ExportSessionStats,
  ExportSessionStatsCacheMeta,
  ExportSessionStatsOptions,
  ExportTabCounts,
  GetContactsOptions,
  Message,
  MyFootprintData,
  MyFootprintDiagnostics,
  MyFootprintMentionGroup,
  MyFootprintMentionItem,
  MyFootprintPrivateSegment,
  MyFootprintPrivateSession,
  MyFootprintSummary,
  ResourceMessageItem,
  ResourceMessageType,
  SessionDetail,
  SessionDetailExtra,
  SessionDetailFast
} from './chat/types'

export type { ChatSession, Contact, ContactInfo, Message } from './chat/types'

class ChatService {
  private configService: ConfigService
  private runtimeConfig?: { dbPath?: string; decryptKey?: string; myWxid?: string }
  private connected = false
  private readonly dbMonitorListeners = new Set<(type: string, json: string) => void>()
  private avatarCache: Map<string, ContactCacheEntry>
  private readonly avatarCacheTtlMs = 10 * 60 * 1000
  private readonly contactCacheService: ContactCacheService
  private readonly messageCacheService: MessageCacheService
  private sessionTablesCache = new Map<string, { tables: Array<{ tableName: string; dbPath: string }>; updatedAt: number }>()
  private messageTableColumnsCache = new Map<string, { columns: Set<string>; updatedAt: number }>()
  private readonly sessionTablesCacheTtl = 300000 // 5分钟
  private readonly messageTableColumnsCacheTtlMs = 30 * 60 * 1000
  private messageDbCountSnapshotCache: {
    dbPaths: string[]
    dbSignature: string
    updatedAt: number
  } | null = null
  private readonly messageDbCountSnapshotCacheTtlMs = 8000
  private initFailureDialogShown = false
  private readonly myFootprintService: MyFootprintService
  private readonly sessionStatsService: SessionStatsService
  private readonly mediaAssetsService: MediaAssetsService
  private readonly messageCursorService: MessageCursorService
  private readonly contactsService: ContactsService
  private readonly sessionDetailService: SessionDetailService
  private readonly sessionListService: SessionListService
  private readonly antiRevokeService: AntiRevokeService
  private readonly sessionContactService: SessionContactService
  private readonly emojiService: EmojiService
  private readonly sessionFilterService: SessionFilterService
  private readonly messageParseService: MessageParseService
  private readonly messageQueryService: MessageQueryService

  constructor() {
    this.configService = new ConfigService()
    this.contactCacheService = new ContactCacheService(this.configService.getCacheBasePath())
    const persisted = this.contactCacheService.getAllEntries()
    this.avatarCache = new Map(Object.entries(persisted))
    this.messageCacheService = new MessageCacheService(this.configService.getCacheBasePath())
    this.sessionFilterService = new SessionFilterService()
    this.messageParseService = new MessageParseService(this.createMessageParseHost())
    this.messageQueryService = new MessageQueryService(this.messageParseService)
    this.myFootprintService = new MyFootprintService(this.createMyFootprintHost())
    this.sessionStatsService = new SessionStatsService(
      this.createSessionStatsHost(),
      this.configService.getCacheBasePath()
    )
    this.mediaAssetsService = new MediaAssetsService(
      this.createMediaAssetsHost(),
      this.configService.getCacheBasePath()
    )
    this.messageCursorService = new MessageCursorService(
      this.createMessageCursorHost(),
      this.messageCacheService
    )
    this.contactsService = new ContactsService(this.createContactsHost())
    this.sessionDetailService = new SessionDetailService(this.createSessionDetailHost())
    this.sessionListService = new SessionListService(this.createSessionListHost())
    this.antiRevokeService = new AntiRevokeService(this.createAntiRevokeHost())
    this.sessionContactService = new SessionContactService(this.createSessionContactHost())
    this.emojiService = new EmojiService(this.createEmojiHost())
  }

  private createMessageParseHost(): MessageParseHost {
    return {
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim()
    }
  }

  private createAntiRevokeHost(): AntiRevokeHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getSessions: () => this.getSessions()
    }
  }

  private createSessionContactHost(): SessionContactHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getAvatarCacheEntry: (username) => this.avatarCache.get(username),
      setAvatarCacheEntry: (username, entry) => {
        this.avatarCache.set(username, entry)
      },
      setContactCacheEntries: (entries) => {
        this.contactCacheService.setEntries(entries)
      },
      getAvatarCacheTtlMs: () => this.avatarCacheTtlMs,
      getContact: (username) => this.getContact(username),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim()
    }
  }

  private createEmojiHost(): EmojiHost {
    return {
      getEmojiCacheDir: () => this.getEmojiCacheDir(),
      repairEmoticonFallback: (msg) => this.messageCursorService.repairEmoticonFallback(msg)
    }
  }

  private createSessionListHost(): SessionListHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      refreshSessionMessageCountCacheScope: () => this.refreshSessionMessageCountCacheScope(),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      loadContactLocalTypeMapForEnterpriseOpenim: (usernames) =>
        this.sessionFilterService.loadContactLocalTypeMapForEnterpriseOpenim(usernames),
      getSessionLocalType: (row) => this.sessionFilterService.getSessionLocalType(row),
      shouldKeepSession: (username, localType) => this.sessionFilterService.shouldKeepSession(username, localType),
      isEnterpriseOpenimUsername: (username) => this.sessionFilterService.isEnterpriseOpenimUsername(username),
      isAllowedEnterpriseOpenimByLocalType: (username, localType) =>
        this.sessionFilterService.isAllowedEnterpriseOpenimByLocalType(username, localType),
      getAvatarCacheEntry: (username) => this.avatarCache.get(username),
      applyCachedStatusToSession: (session, username, now) =>
        this.sessionDetailService.applyCachedStatusToSession(session, username, now),
      seedMessageCountHint: (username, messageCountHint) =>
        this.sessionDetailService.seedMessageCountHint(username, messageCountHint),
      setMessageCountHint: (username, count) => this.sessionDetailService.setMessageCountHint(username, count),
      getNewMessages: (sessionId, minTime, limit) => this.getNewMessages(sessionId, minTime, limit)
    }
  }

  private createSessionDetailHost(): SessionDetailHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getCacheScope: () => {
        const dbPath = String(this.configService.get('dbPath') || '')
        const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
        return `${dbPath}::${myWxid}`
      },
      getMessageDbCountSnapshot: (forceRefresh) => this.getMessageDbCountSnapshot(forceRefresh),
      buildMessageDbSignature: (dbPaths) => this.buildMessageDbSignature(dbPaths),
      normalizeExportDiagTraceId: (traceId) => this.normalizeExportDiagTraceId(traceId),
      logExportDiag: (input) => this.logExportDiag(input),
      startExportDiagStep: (input) => this.startExportDiagStep(input),
      endExportDiagStep: (input) => this.endExportDiagStep(input),
      getAvatarCacheEntry: (username) => this.avatarCache.get(username),
      isValidAvatarUrl: (url) => isValidAvatarUrl(url),
      getAvatarsFromHeadImageDb: (usernames) => this.sessionContactService.getAvatarsFromHeadImageDb(usernames)
    }
  }

  private createContactsHost(): ContactsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getDbPath: () => String(this.configService.get('dbPath') || ''),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      isEnterpriseOpenimUsername: (username) => this.sessionFilterService.isEnterpriseOpenimUsername(username),
      isAllowedEnterpriseOpenimByLocalType: (username, localType) =>
        this.sessionFilterService.isAllowedEnterpriseOpenimByLocalType(username, localType),
      quoteSqlIdentifier: (identifier) => this.sessionFilterService.quoteSqlIdentifier(identifier)
    }
  }

  private createMessageCursorHost(): MessageCursorHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      resolveQuotedMessages: (messages, sessionId) => this.resolveQuotedMessages(messages, sessionId),
      markSyntheticUnreadRead: (sessionId, messages) => this.sessionListService.markSyntheticUnreadRead(sessionId, messages),
      chatServiceLog: (message, meta) => this.chatServiceLog(message, meta),
      resolveAccountDir: (dbPath, wxid) => resolveAccountDir(dbPath, wxid),
      getConfigString: (key: string) => String(this.configService.get(key as 'cachePath' | 'dbPath' | 'myWxid') || ''),
      getEmojiCacheDir: () => this.getEmojiCacheDir()
    }
  }

  private createMediaAssetsHost(): MediaAssetsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      connect: () => this.connect(),
      isConnected: () => this.connected,
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      getConfigString: (key: string) => String(this.configService.get(key as 'cachePath' | 'dbPath' | 'myWxid') || ''),
      getMessageByLocalId: (sessionId, localId) => this.messageQueryService.getMessageById(sessionId, localId),
      getSessions: () => this.getSessions(),
      forEachWithConcurrency: (items, limit, worker) => this.forEachWithConcurrency(items, limit, worker),
      chatServiceLog: (message, meta) => this.chatServiceLog(message, meta)
    }
  }

  private createSessionStatsHost(): SessionStatsHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getCacheScope: () => {
        const dbPath = String(this.configService.get('dbPath') || '')
        const myWxid = String(this.configService.getMyWxidCleaned() || '')
        return `${dbPath}::${myWxid}`
      },
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim()
    }
  }

  private createMyFootprintHost(): MyFootprintHost {
    return {
      ensureConnected: () => this.ensureConnected(),
      getMyWxidCleaned: () => String(this.configService.getMyWxidCleaned() || '').trim(),
      getConfig: (key: keyof ConfigSchema) => this.configService.get(key),
      getSessions: () => this.getSessions(),
      getSessionMessageTables: (sessionId) => this.getSessionMessageTables(sessionId),
      getMessageById: (sessionId, localId) => this.messageQueryService.getMessageById(sessionId, localId),
      parseMessage: (row, options) => this.messageParseService.parseMessage(row, options),
      enrichSessionsContactInfo: (usernames, options) => this.enrichSessionsContactInfo(usernames, options),
      quoteSqlIdentifier: (identifier) => this.sessionFilterService.quoteSqlIdentifier(identifier),
      getSessionLocalType: (row) => this.sessionFilterService.getSessionLocalType(row),
      loadContactLocalTypeMapForEnterpriseOpenim: (usernames) =>
        this.sessionFilterService.loadContactLocalTypeMapForEnterpriseOpenim(usernames),
      isEnterpriseOpenimUsername: (username) => this.sessionFilterService.isEnterpriseOpenimUsername(username),
      shouldKeepSession: (username, localType) => this.sessionFilterService.shouldKeepSession(username, localType),
      escapeSqlString: (value) => this.sessionFilterService.escapeSqlString(value),
      resolveMessageSenderUsernameById: (dbPath, senderId) =>
        this.messageParseService.resolveMessageSenderUsernameById(dbPath, senderId)
    }
  }

  setRuntimeConfig(config: { dbPath?: string; decryptKey?: string; myWxid?: string }): void {
    this.runtimeConfig = config
  }

  private extractErrorCode(message?: string | null): number | null {
    const text = String(message || '').trim()
    if (!text) return null
    const match = text.match(/(?:错误码\s*[:：]\s*|\()(-?\d{2,6})(?:\)|\b)/)
    if (!match) return null
    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? parsed : null
  }

  private toCodeOnlyMessage(rawMessage?: string | null, fallbackCode = -3999): string {
    const code = this.extractErrorCode(rawMessage) ?? fallbackCode
    return `错误码: ${code}`
  }

  private async maybeShowInitFailureDialog(errorMessage: string): Promise<void> {
    if (!app.isPackaged) return
    if (this.initFailureDialogShown) return

    const code = this.extractErrorCode(errorMessage)
    if (code === null) return
    const isSecurityCode =
      code === -101 ||
      code === -102 ||
      code === -2299 ||
      code === -2301 ||
      code === -2302 ||
      code === -1006 ||
      (code <= -2201 && code >= -2212)
    if (!isSecurityCode) return

    this.initFailureDialogShown = true
    const detail = [
      `错误码: ${code}`
    ].join('\n')

    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'WeFlow 启动失败',
        message: '启动失败，请反馈错误码。',
        detail,
        buttons: ['确定'],
        noLink: true
      })
    } catch {
      // 弹窗失败不阻断主流程
    }
  }

  /**
   * 连接数据库
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = String(this.runtimeConfig?.myWxid || this.configService.get('myWxid') || '').trim()
      const dbPath = String(this.runtimeConfig?.dbPath || this.configService.get('dbPath') || '').trim()
      const decryptKey = String(this.runtimeConfig?.decryptKey || this.configService.get('decryptKey') || '').trim()
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }
      if (!dbPath) {
        return { success: false, error: '请先在设置页面配置数据库路径' }
      }
      if (!decryptKey) {
        return { success: false, error: '请先在设置页面配置解密密钥' }
      }

      if (this.connected && wcdbService.isReady()) {
        return { success: true }
      }

      // 使用 ConfigService 统一解析账号目录
      const accountDir = this.configService.getAccountDir(dbPath, wxid)
      if (!accountDir) {
        return { success: false, error: '未找到账号目录，请检查数据库路径和微信ID配置' }
      }

      const openOk = await wcdbService.open(accountDir, decryptKey)
      if (!openOk) {
        const detailedError = this.toCodeOnlyMessage(await wcdbService.getLastInitError())
        await this.maybeShowInitFailureDialog(detailedError)
        return { success: false, error: detailedError }
      }

      this.connected = true

      // 设置数据库监控
      this.setupDbMonitor()

      // 预热 listMediaDbs 缓存（后台异步执行，不阻塞连接）
      void this.mediaAssetsService.warmupMediaDbsCache()

      return { success: true }
    } catch (e) {
      console.error('ChatService: 连接数据库失败:', e)
      return { success: false, error: this.toCodeOnlyMessage(String(e), -3998) }
    }
  }

  private monitorSetup = false

  addDbMonitorListener(listener: (type: string, json: string) => void): () => void {
    this.dbMonitorListeners.add(listener)
    return () => {
      this.dbMonitorListeners.delete(listener)
    }
  }

  private setupDbMonitor() {
    if (this.monitorSetup) return
    this.monitorSetup = true

    // 使用 C++数据服务内部的文件监控 (ReadDirectoryChangesW)
    // 这种方式更高效，且不占用 JS 线程，并能直接监听 session/message 目录变更
    wcdbService.setMonitor((type, json) => {
      this.handleSessionStatsMonitorChange(type, json)
      for (const listener of this.dbMonitorListeners) {
        try {
          listener(type, json)
        } catch (error) {
          console.error('[ChatService] 数据库监听回调失败:', error)
        }
      }
      const windows = BrowserWindow.getAllWindows()
      // 广播给所有渲染进程窗口
      windows.forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('wcdb-change', { type, json })
        }
      })
    })
  }

  async warmupMessageDbSnapshot(): Promise<{ success: boolean; messageDbCount?: number; mediaDbCount?: number; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const [messageSnapshot, mediaResult] = await Promise.all([
        this.getMessageDbCountSnapshot(true),
        wcdbService.listMediaDbs()
      ])

      let messageDbCount = 0
      if (messageSnapshot.success && Array.isArray(messageSnapshot.dbPaths)) {
        messageDbCount = messageSnapshot.dbPaths.length
      }

      let mediaDbCount = 0
      if (mediaResult.success && Array.isArray(mediaResult.data)) {
        this.mediaAssetsService.applyMediaDbList(mediaResult.data)
        mediaDbCount = mediaResult.data.length
      }

      if (!messageSnapshot.success && !mediaResult.success) {
        return {
          success: false,
          error: messageSnapshot.error || mediaResult.error || '初始化消息库索引失败'
        }
      }

      return { success: true, messageDbCount, mediaDbCount }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    if (this.connected && wcdbService.isReady()) {
      return { success: true }
    }
    if (!wcdbService.isReady()) {
      this.monitorSetup = false
    }
    const result = await this.connect()
    if (!result.success) {
      this.connected = false
      return { success: false, error: result.error }
    }
    return { success: true }
  }

  /**
   * 关闭数据库连接
   */

  async close(): Promise<void> {
    try {
      await this.messageCursorService.closeAllCursors()
      await wcdbService.close()
    } catch (e) {
      console.error('ChatService: 关闭数据库失败:', e)
    }
    this.connected = false
    this.monitorSetup = false
  }

  /**
   * 修改消息内容
   */
  async updateMessage(sessionId: string, localId: number, createTime: number, newContent: string): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      return await wcdbService.updateMessage(sessionId, localId, createTime, newContent)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, localId: number, createTime: number, dbPathHint?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      return await wcdbService.deleteMessage(sessionId, localId, createTime, dbPathHint)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async checkAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
    error?: string
  }> {
    return this.antiRevokeService.checkAntiRevokeTriggers(sessionIds)
  }

  async installAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
    error?: string
  }> {
    return this.antiRevokeService.installAntiRevokeTriggers(sessionIds)
  }

  async uninstallAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; error?: string }>
    error?: string
  }> {
    return this.antiRevokeService.uninstallAntiRevokeTriggers(sessionIds)
  }

  async getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    return this.sessionListService.getSessions()
  }

  async getAntiRevokeSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    return this.antiRevokeService.getAntiRevokeSessions()
  }

  async markAllSessionsRead(): Promise<{ success: boolean; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }
      const result = await wcdbService.markAllSessionsRead()
      if (result.success) {
        this.sessionListService.clearSyntheticUnreadState()
      }
      return result
    } catch (e) {
      console.error('ChatService: 一键已读失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 异步补充会话列表的联系人信息（公开方法，供前端调用）
   */
  async enrichSessionsContactInfo(
    usernames: string[],
    options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
  ): Promise<{
    success: boolean
    contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
    error?: string
  }> {
    return this.sessionContactService.enrichSessionsContactInfo(usernames, options)
  }

  private async getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>> {
    return this.sessionContactService.getAvatarsFromHeadImageDb(usernames)
  }

  /**
   * 获取联系人类型数量（好友、群聊、公众号、曾经的好友）
   */
  async getContactTypeCounts(): Promise<{ success: boolean; counts?: ExportTabCounts; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const result = await wcdbService.getContactTypeCounts()
      if (!result.success || !result.counts) {
        return { success: false, error: result.error || '获取联系人类型数量失败' }
      }

      const counts: ExportTabCounts = {
        private: Number(result.counts.private || 0),
        group: Number(result.counts.group || 0),
        official: Number(result.counts.official || 0),
        former_friend: Number(result.counts.former_friend || 0)
      }

      return { success: true, counts }
    } catch (e) {
      console.error('ChatService: 获取联系人类型数量失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取导出页会话分类数量（轻量接口，优先用于顶部 Tab 数量展示）
   */
  async getExportTabCounts(): Promise<{ success: boolean; counts?: ExportTabCounts; error?: string }> {
    return this.getContactTypeCounts()
  }

  private async listMessageDbPathsForCount(): Promise<{ success: boolean; dbPaths?: string[]; error?: string }> {
    try {
      const result = await wcdbService.listMessageDbs()
      if (!result.success) {
        return { success: false, error: result.error || '获取消息数据库列表失败' }
      }
      const normalized = Array.from(new Set(
        (result.data || [])
          .map(pathItem => String(pathItem || '').trim())
          .filter(Boolean)
      ))
      return { success: true, dbPaths: normalized }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private buildMessageDbSignature(dbPaths: string[]): string {
    if (!Array.isArray(dbPaths) || dbPaths.length === 0) return 'empty'
    const parts: string[] = []
    const sortedPaths = [...dbPaths].sort()
    for (const dbPath of sortedPaths) {
      try {
        const stat = statSync(dbPath)
        parts.push(`${dbPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      } catch {
        parts.push(`${dbPath}:missing`)
      }
    }
    return parts.join('|')
  }

  private buildSessionHashLookup(sessionIds: string[]): {
    full32: Map<string, string>
    short16: Map<string, string | null>
  } {
    const full32 = new Map<string, string>()
    const short16 = new Map<string, string | null>()
    for (const sessionId of sessionIds) {
      const hash = crypto.createHash('md5').update(sessionId).digest('hex').toLowerCase()
      full32.set(hash, sessionId)
      const shortHash = hash.slice(0, 16)
      const existing = short16.get(shortHash)
      if (existing === undefined) {
        short16.set(shortHash, sessionId)
      } else if (existing !== sessionId) {
        short16.set(shortHash, null)
      }
    }
    return { full32, short16 }
  }

  private matchSessionIdByTableName(
    tableName: string,
    hashLookup: {
      full32: Map<string, string>
      short16: Map<string, string | null>
    }
  ): string | null {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized.startsWith('msg_')) return null
    const suffix = normalized.slice(4)

    const directFull = hashLookup.full32.get(suffix)
    if (directFull) return directFull

    if (suffix.length >= 16) {
      const shortCandidate = hashLookup.short16.get(suffix.slice(0, 16))
      if (typeof shortCandidate === 'string') return shortCandidate
    }

    const hashMatch = normalized.match(/[a-f0-9]{32}|[a-f0-9]{16}/i)
    if (!hashMatch || !hashMatch[0]) return null
    const matchedHash = hashMatch[0].toLowerCase()
    if (matchedHash.length >= 32) {
      const full = hashLookup.full32.get(matchedHash)
      if (full) return full
    }
    const short = hashLookup.short16.get(matchedHash.slice(0, 16))
    return typeof short === 'string' ? short : null
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(options?: GetContactsOptions): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    return this.contactsService.getContacts(options)
  }

  /**
   * 批量获取会话消息总数（轻量接口，用于列表优先排序）
   */
  async getSessionMessageCounts(
    sessionIds: string[],
    options?: { preferHintCache?: boolean; bypassSessionCache?: boolean; traceId?: string }
  ): Promise<{
    success: boolean
    counts?: Record<string, number>
    error?: string
  }> {
    return this.sessionDetailService.getSessionMessageCounts(sessionIds, options)
  }

  async getSessionStatuses(usernames: string[]): Promise<{
    success: boolean
    map?: Record<string, { isFolded?: boolean; isMuted?: boolean }>
    error?: string
  }> {
    return this.sessionDetailService.getSessionStatuses(usernames)
  }

  async getSessionDetailFast(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailFast
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetailFast(sessionId)
  }

  async getSessionDetailExtra(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetailExtra
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetailExtra(sessionId)
  }

  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: SessionDetail
    error?: string
  }> {
    return this.sessionDetailService.getSessionDetail(sessionId)
  }

  async getGroupMyMessageCountHint(chatroomId: string): Promise<{
    success: boolean
    count?: number
    updatedAt?: number
    source?: 'memory' | 'disk'
    error?: string
  }> {
    return this.sessionStatsService.getGroupMyMessageCountHint(chatroomId)
  }

  async setGroupMyMessageCountHint(
    chatroomId: string,
    messageCount: number,
    updatedAt?: number
  ): Promise<{ success: boolean; updatedAt?: number; error?: string }> {
    return this.sessionStatsService.setGroupMyMessageCountHint(chatroomId, messageCount, updatedAt)
  }

  async getExportSessionStats(sessionIds: string[], options: ExportSessionStatsOptions = {}): Promise<{
    success: boolean
    data?: Record<string, ExportSessionStats>
    cache?: Record<string, ExportSessionStatsCacheMeta>
    needsRefresh?: string[]
    error?: string
  }> {
    return this.sessionStatsService.getExportSessionStats(sessionIds, options)
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50,
    startTime: number = 0,
    endTime: number = 0,
    ascending: boolean = false
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    return this.messageCursorService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  }

  async getCachedSessionMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.messageCursorService.getCachedSessionMessages(sessionId)
  }

  async getLatestMessages(
    sessionId: string,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; nextOffset?: number; error?: string }> {
    return this.messageCursorService.getLatestMessages(sessionId, limit)
  }

  async getNewMessages(
    sessionId: string,
    minTime: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.messageCursorService.getNewMessages(sessionId, minTime, limit)
  }



  private normalizeExportDiagTraceId(traceId?: string): string {
    const normalized = String(traceId || '').trim()
    return normalized
  }

  private logExportDiag(input: {
    traceId?: string
    source?: 'backend' | 'main' | 'frontend' | 'worker'
    level?: 'debug' | 'info' | 'warn' | 'error'
    message: string
    stepId?: string
    stepName?: string
    status?: 'running' | 'done' | 'failed' | 'timeout'
    durationMs?: number
    data?: Record<string, unknown>
  }): void {
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (!traceId) return
    exportCardDiagnosticsService.log({
      traceId,
      source: input.source || 'backend',
      level: input.level || 'info',
      message: input.message,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status,
      durationMs: input.durationMs,
      data: input.data
    })
  }

  private startExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    message: string
    data?: Record<string, unknown>
  }): number {
    const startedAt = Date.now()
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (traceId) {
      exportCardDiagnosticsService.stepStart({
        traceId,
        stepId: input.stepId,
        stepName: input.stepName,
        source: 'backend',
        message: input.message,
        data: input.data
      })
    }
    return startedAt
  }

  private endExportDiagStep(input: {
    traceId?: string
    stepId: string
    stepName: string
    startedAt: number
    success: boolean
    message?: string
    data?: Record<string, unknown>
  }): void {
    const traceId = this.normalizeExportDiagTraceId(input.traceId)
    if (!traceId) return
    exportCardDiagnosticsService.stepEnd({
      traceId,
      stepId: input.stepId,
      stepName: input.stepName,
      source: 'backend',
      status: input.success ? 'done' : 'failed',
      message: input.message || (input.success ? `${input.stepName} 完成` : `${input.stepName} 失败`),
      durationMs: Math.max(0, Date.now() - input.startedAt),
      data: input.data
    })
  }

  private refreshSessionMessageCountCacheScope(): void {
    const dbPath = String(this.configService.get('dbPath') || '')
    const myWxid = String(this.configService.getMyWxidCleaned() || '')
    const scope = `${dbPath}::${myWxid}`
    this.sessionStatsService.refreshCacheScope(scope)
    if (!this.sessionDetailService.onAccountScopeChanged(scope)) {
      return
    }
    this.sessionTablesCache.clear()
    this.messageTableColumnsCache.clear()
    this.messageDbCountSnapshotCache = null
    this.contactsService.clearMemoryCache()
  }

  private handleSessionStatsMonitorChange(type: string, json: string): void {
    this.refreshSessionMessageCountCacheScope()
    const normalizedType = String(type || '').toLowerCase()
    if (
      normalizedType.includes('message') ||
      normalizedType.includes('session') ||
      normalizedType.includes('db')
    ) {
      this.messageDbCountSnapshotCache = null
    }
    this.sessionStatsService.handleDbMonitorChange(type, json)
  }

  private async forEachWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) return
    const concurrency = Math.max(1, Math.min(limit, items.length))
    let index = 0

    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const current = index
        index += 1
        if (current >= items.length) return
        await worker(items[current])
      }
    })

    await Promise.all(runners)
  }

  private async getMessageDbCountSnapshot(forceRefresh = false): Promise<{
    success: boolean
    dbPaths?: string[]
    dbSignature?: string
    error?: string
  }> {
    const now = Date.now()
    if (!forceRefresh && this.messageDbCountSnapshotCache) {
      if (now - this.messageDbCountSnapshotCache.updatedAt <= this.messageDbCountSnapshotCacheTtlMs) {
        return {
          success: true,
          dbPaths: [...this.messageDbCountSnapshotCache.dbPaths],
          dbSignature: this.messageDbCountSnapshotCache.dbSignature
        }
      }
    }

    const dbPathsResult = await this.listMessageDbPathsForCount()
    if (!dbPathsResult.success || !dbPathsResult.dbPaths) {
      return { success: false, error: dbPathsResult.error || '获取消息数据库列表失败' }
    }
    const dbPaths = dbPathsResult.dbPaths
    const dbSignature = this.buildMessageDbSignature(dbPaths)
    this.messageDbCountSnapshotCache = {
      dbPaths: [...dbPaths],
      dbSignature,
      updatedAt: now
    }
    return { success: true, dbPaths, dbSignature }
  }

  private async getSessionMessageTables(sessionId: string): Promise<Array<{ tableName: string; dbPath: string }>> {
    const now = Date.now()
    const cached = this.sessionTablesCache.get(sessionId)
    if (cached && now - cached.updatedAt <= this.sessionTablesCacheTtl && cached.tables.length > 0) {
      return cached.tables
    }
    if (cached) {
      this.sessionTablesCache.delete(sessionId)
    }

    const tableStats = await wcdbService.getMessageTableStats(sessionId)
    if (!tableStats.success || !tableStats.tables || tableStats.tables.length === 0) {
      return []
    }

    const tables = tableStats.tables
      .map(t => ({ tableName: t.table_name || t.name, dbPath: t.db_path }))
      .filter(t => t.tableName && t.dbPath) as Array<{ tableName: string; dbPath: string }>

    if (tables.length > 0) {
      this.sessionTablesCache.set(sessionId, {
        tables,
        updatedAt: now
      })
    }
    return tables
  }



  /**
   * HTTP API 复用消息解析逻辑，确保和应用内展示一致。
   */
  
  mapRowsToMessagesLiteForApi(rows: Record<string, any>[]): Message[] {
    const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
    return mapRowsToMessagesLite(rows, myWxid)
  }

  mapRowsToMessagesForApi(rows: Record<string, any>[], sessionId: string): Message[] {
    const myWxid = String(this.configService.getMyWxidCleaned() || '').trim()
    return mapRowsToMessages(rows, sessionId, myWxid)
  }

  private isChatQuoteDebugEnabled(): boolean {
    if (String(process.env.WEFLOW_CHAT_QUOTE_DEBUG || '').trim() === '1') return true
    return this.configService.get('chatQuoteDebugLogEnabled') === true
  }

  private shouldLogChatServiceVerbose(): boolean {
    return this.configService.get('logEnabled') === true
  }

  private chatServiceLog(message: string, meta?: unknown): void {
    if (!this.shouldLogChatServiceVerbose()) return
    if (meta !== undefined) {
      console.log(`[ChatService] ${message}`, meta)
    } else {
      console.log(`[ChatService] ${message}`)
    }
  }

  private debugQuoteLog(message: string, meta?: unknown): void {
    if (!this.isChatQuoteDebugEnabled()) return
    if (meta !== undefined) {
      console.log(`[DEBUG] ${message}`, meta)
    } else {
      console.log(`[DEBUG] ${message}`)
    }
  }

  async resolveQuotedMessages(messages: Message[], sessionId: string): Promise<void> {
    return resolveQuotedMessagesImpl(messages, sessionId, (message, meta) => this.debugQuoteLog(message, meta))
  }

  async getContact(username: string): Promise<Contact | null> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) return null
      const result = await wcdbService.getContact(username)
      if (!result.success || !result.contact) return null
      const contact = result.contact as Record<string, any>
      let alias = String(contact.alias || contact.Alias || '')
      //数据服务有时不返回 alias 字段，补一条直接 SQL 查询兜底
      if (!alias) {
        try {
          const aliasResult = await wcdbService.getContactAliasMap([username])
          if (aliasResult.success && aliasResult.map && aliasResult.map[username]) {
            alias = String(aliasResult.map[username] || '')
          }
        } catch {
          // 兜底失败不影响主流程
        }
      }
      return {
        username: String(contact.username || contact.user_name || contact.userName || username || ''),
        alias,
        remark: String(contact.remark || contact.Remark || ''),
        // 兼容不同表结构字段，避免 nick_name 丢失导致侧边栏退化到 wxid。
        nickName: String(contact.nickName || contact.nick_name || contact.nickname || contact.NickName || '')
      }
    } catch {
      return null
    }
  }

  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string } | null> {
    return this.sessionContactService.getContactAvatar(username)
  }

  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    return this.sessionContactService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  }

  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    return this.sessionContactService.getMyAvatarUrl()
  }

  /**
   * 获取表情包缓存目录
   */
  /**
   * 获取语音缓存目录
   */

  private getEmojiCacheDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) {
      return join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    const documentsPath = app.getPath('documents')
    return join(documentsPath, 'WeFlow', 'Emojis')
  }

  async clearCaches(options?: { includeMessages?: boolean; includeContacts?: boolean; includeEmojis?: boolean }): Promise<{ success: boolean; error?: string }> {
    const includeMessages = options?.includeMessages !== false
    const includeContacts = options?.includeContacts !== false
    const includeEmojis = options?.includeEmojis !== false
    const errors: string[] = []

    if (includeContacts) {
      this.avatarCache.clear()
      this.contactCacheService.clear()
      this.contactsService.clearMemoryCache()
    }

    if (includeMessages) {
      await this.messageCursorService.closeAllCursors()
      this.messageCacheService.clear()
      this.mediaAssetsService.clearVoiceCaches()
    }

    if (includeMessages || includeContacts) {
      this.sessionStatsService.clearCaches()
    }

    if (includeEmojis) {
      const emojiResult = this.emojiService.clearEmojiCacheDir()
      if (!emojiResult.success && emojiResult.error) {
        errors.push(emojiResult.error)
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') }
    }
    return { success: true }
  }

  async downloadEmoji(cdnUrl: string, md5?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
    return this.emojiService.downloadEmoji(cdnUrl, md5)
  }

  async getImageData(sessionId: string, msgId: string): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getImageData(sessionId, msgId)
  }

  async getVoiceData(
    sessionId: string,
    msgId: string,
    createTime?: number,
    serverId?: string | number,
    senderWxidOpt?: string
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceData(sessionId, msgId, createTime, serverId, senderWxidOpt)
  }

  async preloadVoiceDataBatch(
    sessionId: string,
    messages: Array<{
      localId?: number | string
      createTime?: number | string
      serverId?: number | string
      senderWxid?: string | null
    }>,
    options?: { chunkSize?: number; decodeConcurrency?: number }
  ): Promise<{ success: boolean; prepared?: number; error?: string }> {
    return this.mediaAssetsService.preloadVoiceDataBatch(sessionId, messages, options)
  }

  async resolveVoiceCache(
    sessionId: string,
    msgId: string
  ): Promise<{ success: boolean; hasCache: boolean; data?: string }> {
    return this.mediaAssetsService.resolveVoiceCache(sessionId, msgId)
  }

  async getVoiceData_Legacy(
    sessionId: string,
    msgId: string
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceData_Legacy(sessionId, msgId)
  }

  async getVoiceTranscript(
    sessionId: string,
    msgId: string,
    createTime?: number,
    onPartial?: (text: string) => void,
    senderWxid?: string
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return this.mediaAssetsService.getVoiceTranscript(sessionId, msgId, createTime, onPartial, senderWxid)
  }

  flushTranscriptCache(): void {
    this.mediaAssetsService.flushTranscriptCache()
  }

  hasTranscriptCache(sessionId: string, msgId: string, createTime?: number): boolean {
    return this.mediaAssetsService.hasTranscriptCache(sessionId, msgId, createTime)
  }

  getCachedVoiceTranscriptCountMap(sessionIds: string[]): Record<string, number> {
    return this.mediaAssetsService.getCachedVoiceTranscriptCountMap(sessionIds)
  }

  async getAllVoiceMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.mediaAssetsService.getAllVoiceMessages(sessionId)
  }

  async getAllImageMessages(
    sessionId: string
  ): Promise<{
    success: boolean
    images?: { imageMd5?: string; imageOriginSourceMd5?: string; imageDatName?: string; createTime?: number }[]
    error?: string
  }> {
    return this.mediaAssetsService.getAllImageMessages(sessionId)
  }

  async getResourceMessages(options?: {
    sessionId?: string
    types?: ResourceMessageType[]
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: ResourceMessageItem[]
    total?: number
    hasMore?: boolean
    error?: string
  }> {
    return this.mediaAssetsService.getResourceMessages(options)
  }

  async getMessageDates(sessionId: string): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getMessageDates(sessionId)
      if (!result.success) {
        throw new Error(result.error || '查询失败')
      }

      const dates = result.dates || []

      this.chatServiceLog(`会话 ${sessionId} 共有 ${dates.length} 个有消息的日期`)
      return { success: true, dates }
    } catch (e) {
      console.error('[ChatService] 获取消息日期失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const result = await wcdbService.getSessionMessageDateCounts(sessionId)
      if (!result.success || !result.counts) {
        return { success: false, error: result.error || '查询每日消息数失败' }
      }
      const counts = result.counts

      this.chatServiceLog(`会话 ${sessionId} 获取到 ${Object.keys(counts).length} 个日期的消息计数`)
      return { success: true, counts }
    } catch (error) {
      console.error('[ChatService] 获取每日消息数失败:', error)
      return { success: false, error: String(error) }
    }
  }

  async getMyFootprintStats(
    beginTimestamp: number,
    endTimestamp: number,
    options?: {
      myWxid?: string
      privateSessionIds?: string[]
      groupSessionIds?: string[]
      mentionLimit?: number
      privateLimit?: number
      mentionMode?: 'text_at_me' | string
    }
  ) {
    return this.myFootprintService.getMyFootprintStats(beginTimestamp, endTimestamp, options)
  }

  async exportMyFootprint(
    beginTimestamp: number,
    endTimestamp: number,
    format: 'csv' | 'json',
    filePath: string
  ) {
    return this.myFootprintService.exportMyFootprint(beginTimestamp, endTimestamp, format, filePath)
  }

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    return this.messageQueryService.getMessageById(sessionId, localId)
  }

  async searchMessages(keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return this.messageQueryService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  }

  async execQuery(kind: string, path: string | null, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    try {
      const connectResult = await this.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }
      // fallback-exec: 仅用于诊断/低频兼容，不作为业务主路径
      return wcdbService.execQuery(kind, path, sql)
    } catch (e) {
      console.error('ChatService: 执行自定义查询失败:', e)
      return { success: false, error: String(e) }
    }
  }


  async downloadEmojiFile(msg: Message): Promise<string | null> {
    return this.emojiService.downloadEmojiFile(msg)
  }
}

export const chatService = new ChatService()
