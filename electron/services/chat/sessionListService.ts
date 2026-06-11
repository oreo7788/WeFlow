import { wcdbService } from '../wcdbService'
import { getRowInt } from './messageRowUtils'
import { cleanString, getMessageTypeLabel } from './messageParsing'
import type { ChatSession, Message, SyntheticUnreadState } from './types'
import type { SessionListHost } from './sessionListHost'
import { logPerf, nowMs } from '../../utils/perfLogger'

export class SessionListService {
  private syntheticUnreadState = new Map<string, SyntheticUnreadState>()
  private readonly syntheticUnreadConcurrency = 4
  private readonly syntheticUnreadDebounceMs = 250

  private getSessionsInFlight: Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> | null = null
  private enrichmentDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private enrichmentInFlight: Promise<void> | null = null
  private enrichmentReschedule = false
  private pendingEnrichmentSessions: ChatSession[] | null = null

  constructor(private readonly host: SessionListHost) {}

  clearSyntheticUnreadState(): void {
    this.syntheticUnreadState.clear()
  }

  markSyntheticUnreadRead(sessionId: string, messages: Message[] = []): void {
    const normalized = String(sessionId || '').trim()
    if (!this.shouldUseSyntheticUnread(normalized)) return

    let latestTimestamp = 0
    const state = this.syntheticUnreadState.get(normalized)
    if (state) latestTimestamp = Math.max(latestTimestamp, state.latestTimestamp, state.scannedTimestamp)
    for (const message of messages) {
      const createTime = Number(message.createTime || 0)
      if (Number.isFinite(createTime) && createTime > latestTimestamp) {
        latestTimestamp = Math.floor(createTime)
      }
    }

    this.syntheticUnreadState.set(normalized, {
      readTimestamp: latestTimestamp,
      scannedTimestamp: latestTimestamp,
      latestTimestamp,
      unreadCount: 0,
      summary: state?.summary,
      summaryTimestamp: state?.summaryTimestamp,
      lastMsgType: state?.lastMsgType
    })
  }

  async getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    if (this.getSessionsInFlight) {
      logPerf('sessionList', 'getSessions.coalesced', 0)
      return this.getSessionsInFlight
    }

    const task = this.buildSessionsFast()
    this.getSessionsInFlight = task.finally(() => {
      this.getSessionsInFlight = null
    })

    const result = await this.getSessionsInFlight
    if (result.success && Array.isArray(result.sessions)) {
      this.scheduleSyntheticUnreadEnrichment(result.sessions)
    }
    return result
  }

  private async buildSessionsFast(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    const startedAt = nowMs()
    try {
      const connectStartedAt = nowMs()
      const connectResult = await this.host.ensureConnected()
      const connectMs = nowMs() - connectStartedAt
      if (!connectResult.success) {
        logPerf('sessionList', 'getSessions.connectFailed', nowMs() - startedAt, {
          connectMs
        })
        return { success: false, error: connectResult.error }
      }
      this.host.refreshSessionMessageCountCacheScope()

      const queryStartedAt = nowMs()
      const result = await wcdbService.getSessions()
      const queryMs = nowMs() - queryStartedAt
      if (!result.success || !result.sessions) {
        logPerf('sessionList', 'getSessions.queryFailed', nowMs() - startedAt, {
          connectMs,
          queryMs
        })
        return { success: false, error: result.error || '获取会话失败' }
      }
      const rows = result.sessions as Record<string, any>[]
      if (rows.length > 0 && (rows[0]._error || rows[0]._info)) {
        const info = rows[0]
        const detail = info._error || info._info
        const tableInfo = info.table ? ` table=${info.table}` : ''
        const tables = info.tables ? ` tables=${info.tables}` : ''
        const columns = info.columns ? ` columns=${info.columns}` : ''
        return { success: false, error: `会话表异常: ${detail}${tableInfo}${tables}${columns}` }
      }

      const openimStartedAt = nowMs()
      const openimLocalTypeMap = await this.host.loadContactLocalTypeMapForEnterpriseOpenim(rows.map((row) =>
        String(
          row.username ||
          row.user_name ||
          row.userName ||
          row.usrName ||
          row.UsrName ||
          row.talker ||
          row.talker_id ||
          row.talkerId ||
          ''
        ).trim()
      ))
      const openimMs = nowMs() - openimStartedAt

      const transformStartedAt = nowMs()
      const sessions: ChatSession[] = []
      const now = Date.now()
      const myWxid = this.host.getMyWxidCleaned()

      for (const row of rows) {
        const username =
          row.username ||
          row.user_name ||
          row.userName ||
          row.usrName ||
          row.UsrName ||
          row.talker ||
          row.talker_id ||
          row.talkerId ||
          ''

        let sessionLocalType = this.host.getSessionLocalType(row)
        if (!Number.isFinite(sessionLocalType) && this.host.isEnterpriseOpenimUsername(username)) {
          sessionLocalType = openimLocalTypeMap.get(username)
        }
        if (!this.host.shouldKeepSession(username, sessionLocalType)) continue

        const sortTs = parseInt(
          row.sort_timestamp ||
          row.sortTimestamp ||
          row.sort_time ||
          row.sortTime ||
          '0',
          10
        )
        const lastTs = parseInt(
          row.last_timestamp ||
          row.lastTimestamp ||
          row.last_msg_time ||
          row.lastMsgTime ||
          String(sortTs),
          10
        )

        const summary = cleanString(row.summary || row.digest || row.last_msg || row.lastMsg || '')
        const lastMsgType = parseInt(row.last_msg_type || row.lastMsgType || '0', 10)
        const messageCountHintRaw =
          row.message_count ??
          row.messageCount ??
          row.msg_count ??
          row.msgCount ??
          row.total_count ??
          row.totalCount ??
          row.n_msg ??
          row.nMsg ??
          row.message_num ??
          row.messageNum
        const parsedMessageCountHint = Number(messageCountHintRaw)
        const messageCountHint = Number.isFinite(parsedMessageCountHint) && parsedMessageCountHint >= 0
          ? Math.floor(parsedMessageCountHint)
          : undefined

        let displayName = username
        let avatarUrl: string | undefined = undefined
        const cached = this.host.getAvatarCacheEntry(username)
        if (cached) {
          displayName = cached.displayName || username
          avatarUrl = cached.avatarUrl
        }

        const nextSession: ChatSession = {
          username,
          type: parseInt(row.type || '0', 10),
          unreadCount: parseInt(row.unread_count || row.unreadCount || row.unreadcount || '0', 10),
          summary: summary || getMessageTypeLabel(lastMsgType),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType,
          messageCountHint,
          displayName,
          avatarUrl,
          lastMsgSender: row.last_msg_sender,
          lastSenderDisplayName: row.last_sender_display_name,
          selfWxid: myWxid
        }

        this.host.applyCachedStatusToSession(nextSession, username, now)
        sessions.push(nextSession)
        this.host.seedMessageCountHint(username, messageCountHint)
      }
      const transformMs = nowMs() - transformStartedAt

      const officialStartedAt = nowMs()
      await this.addMissingOfficialSessions(sessions, myWxid)
      const officialMs = nowMs() - officialStartedAt

      const cachedSyntheticStartedAt = nowMs()
      this.applyCachedSyntheticUnreadSnapshots(sessions)
      const cachedSyntheticMs = nowMs() - cachedSyntheticStartedAt

      const sortStartedAt = nowMs()
      sessions.sort((a, b) => Number(b.sortTimestamp || b.lastTimestamp || 0) - Number(a.sortTimestamp || a.lastTimestamp || 0))
      const sortMs = nowMs() - sortStartedAt

      logPerf('sessionList', 'getSessions', nowMs() - startedAt, {
        rows: rows.length,
        returned: sessions.length,
        connectMs,
        queryMs,
        openimMs,
        transformMs,
        officialMs,
        syntheticUnreadMs: 0,
        cachedSyntheticMs,
        syntheticUnreadDeferred: true,
        sortMs
      })

      return { success: true, sessions }
    } catch (e) {
      logPerf('sessionList', 'getSessions.error', nowMs() - startedAt)
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private scheduleSyntheticUnreadEnrichment(sessions: ChatSession[]): void {
    this.pendingEnrichmentSessions = sessions.map((session) => ({ ...session }))
    if (this.enrichmentDebounceTimer) {
      clearTimeout(this.enrichmentDebounceTimer)
    }
    this.enrichmentDebounceTimer = setTimeout(() => {
      this.enrichmentDebounceTimer = null
      void this.runSyntheticUnreadEnrichment()
    }, this.syntheticUnreadDebounceMs)
  }

  private async runSyntheticUnreadEnrichment(): Promise<void> {
    if (this.enrichmentInFlight) {
      this.enrichmentReschedule = true
      return
    }

    const sessions = this.pendingEnrichmentSessions
    if (!sessions || sessions.length === 0) return

    const startedAt = nowMs()
    this.enrichmentInFlight = (async () => {
      try {
        await this.applySyntheticUnreadCounts(sessions)
        sessions.sort((a, b) => Number(b.sortTimestamp || b.lastTimestamp || 0) - Number(a.sortTimestamp || a.lastTimestamp || 0))
        logPerf('sessionList', 'enrichSyntheticUnread', nowMs() - startedAt, {
          returned: sessions.length
        })
        this.host.notifySessionsEnriched(sessions)
      } catch (error) {
        console.warn('[ChatService] 后台公众号未读增强失败:', error)
        logPerf('sessionList', 'enrichSyntheticUnread.error', nowMs() - startedAt)
      }
    })().finally(() => {
      this.enrichmentInFlight = null
      if (this.enrichmentReschedule) {
        this.enrichmentReschedule = false
        void this.runSyntheticUnreadEnrichment()
      }
    })

    await this.enrichmentInFlight
  }

  private applyCachedSyntheticUnreadSnapshots(sessions: ChatSession[]): void {
    for (const session of sessions) {
      if (!this.shouldUseSyntheticUnread(session.username)) continue
      const state = this.syntheticUnreadState.get(session.username)
      if (!state) continue

      if (state.summary) {
        session.summary = state.summary
        session.lastMsgType = Number(state.lastMsgType || session.lastMsgType || 0)
      }
      session.unreadCount = Math.max(Number(session.unreadCount || 0), state.unreadCount)
      if (state.latestTimestamp > 0) {
        session.lastTimestamp = Math.max(Number(session.lastTimestamp || 0), state.latestTimestamp)
        session.sortTimestamp = Math.max(Number(session.sortTimestamp || 0), state.latestTimestamp)
      }
      if (state.summaryTimestamp && state.summaryTimestamp > 0) {
        session.sortTimestamp = Math.max(Number(session.sortTimestamp || 0), state.summaryTimestamp)
      }
    }
  }

  private async addMissingOfficialSessions(sessions: ChatSession[], myWxid?: string): Promise<void> {
    const existing = new Set(sessions.map((session) => String(session.username || '').trim()).filter(Boolean))
    try {
      const contactResult = await wcdbService.getContactsCompact()
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) return

      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username || existing.has(username)) continue
        const lowered = username.toLowerCase()
        const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
        const isOfficial = username.startsWith('gh_')
        const isSpecialWeixin = lowered.startsWith('weixin') && lowered !== 'weixin'
        const isSpecialOpenim = this.host.isAllowedEnterpriseOpenimByLocalType(username, localType)
        if (!isOfficial && !isSpecialWeixin && !isSpecialOpenim) continue

        sessions.push({
          username,
          type: 0,
          unreadCount: 0,
          summary: isOfficial ? '查看公众号历史消息' : '暂无会话记录',
          sortTimestamp: 0,
          lastTimestamp: 0,
          lastMsgType: 0,
          displayName: row.remark || row.nick_name || row.alias || username,
          avatarUrl: undefined,
          selfWxid: myWxid
        })
        existing.add(username)
      }
    } catch (error) {
      console.warn('[ChatService] 补充公众号会话失败:', error)
    }
  }

  private shouldUseSyntheticUnread(sessionId: string): boolean {
    const normalized = String(sessionId || '').trim()
    return normalized.startsWith('gh_')
  }

  private async getSessionMessageStatsSnapshot(sessionId: string): Promise<{ total: number; latestTimestamp: number }> {
    const tableStatsResult = await wcdbService.getMessageTableStats(sessionId)
    if (!tableStatsResult.success || !Array.isArray(tableStatsResult.tables)) {
      return { total: 0, latestTimestamp: 0 }
    }

    let total = 0
    let latestTimestamp = 0
    for (const row of tableStatsResult.tables as Record<string, any>[]) {
      const count = Number(row.count ?? row.message_count ?? row.messageCount ?? 0)
      if (Number.isFinite(count) && count > 0) {
        total += Math.floor(count)
      }

      const latest = Number(
        row.last_timestamp ??
        row.lastTimestamp ??
        row.last_time ??
        row.lastTime ??
        row.max_create_time ??
        row.maxCreateTime ??
        0
      )
      if (Number.isFinite(latest) && latest > latestTimestamp) {
        latestTimestamp = Math.floor(latest)
      }
    }

    return { total, latestTimestamp }
  }

  private async applySyntheticUnreadCounts(sessions: ChatSession[]): Promise<void> {
    const candidates = sessions.filter((session) => this.shouldUseSyntheticUnread(session.username))
    if (candidates.length === 0) return

    let nextIndex = 0
    const workerCount = Math.min(this.syntheticUnreadConcurrency, candidates.length)
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const session = candidates[nextIndex]
        nextIndex += 1
        await this.applySyntheticUnreadCount(session)
      }
    }))
  }

  private async applySyntheticUnreadCount(session: ChatSession): Promise<void> {
    try {
      const snapshot = await this.getSessionMessageStatsSnapshot(session.username)
      const latestTimestamp = Math.max(
        Number(session.lastTimestamp || 0),
        Number(session.sortTimestamp || 0),
        snapshot.latestTimestamp
      )
      if (latestTimestamp > 0) {
        session.lastTimestamp = latestTimestamp
        session.sortTimestamp = Math.max(Number(session.sortTimestamp || 0), latestTimestamp)
      }
      if (snapshot.total > 0) {
        session.messageCountHint = Math.max(Number(session.messageCountHint || 0), snapshot.total)
        this.host.setMessageCountHint(session.username, session.messageCountHint)
      }

      let state = this.syntheticUnreadState.get(session.username)
      if (!state) {
        const initialUnread = await this.getInitialSyntheticUnreadState(session.username, latestTimestamp)
        state = {
          readTimestamp: latestTimestamp,
          scannedTimestamp: latestTimestamp,
          latestTimestamp,
          unreadCount: initialUnread.count
        }
        if (initialUnread.latestMessage) {
          state.summary = this.getSessionSummaryFromMessage(initialUnread.latestMessage)
          state.summaryTimestamp = Number(initialUnread.latestMessage.createTime || latestTimestamp)
          state.lastMsgType = Number(initialUnread.latestMessage.localType || 0)
        }
        this.syntheticUnreadState.set(session.username, state)
      }

      let latestMessageForSummary: Message | undefined
      if (latestTimestamp > state.scannedTimestamp) {
        const newMessagesResult = await this.host.getNewMessages(
          session.username,
          Math.max(0, state.scannedTimestamp),
          1000
        )
        if (newMessagesResult.success && Array.isArray(newMessagesResult.messages)) {
          let nextUnread = state.unreadCount
          let nextScannedTimestamp = state.scannedTimestamp
          for (const message of newMessagesResult.messages) {
            const createTime = Number(message.createTime || 0)
            if (!Number.isFinite(createTime) || createTime <= state.scannedTimestamp) continue
            if (message.isSend === 1) continue
            nextUnread += 1
            latestMessageForSummary = message
            if (createTime > nextScannedTimestamp) {
              nextScannedTimestamp = Math.floor(createTime)
            }
          }
          state.unreadCount = nextUnread
          state.scannedTimestamp = Math.max(nextScannedTimestamp, latestTimestamp)
        } else {
          state.scannedTimestamp = latestTimestamp
        }
      }

      state.latestTimestamp = Math.max(state.latestTimestamp, latestTimestamp)
      if (latestMessageForSummary) {
        const summary = this.getSessionSummaryFromMessage(latestMessageForSummary)
        if (summary) {
          state.summary = summary
          state.summaryTimestamp = Number(latestMessageForSummary.createTime || latestTimestamp)
          state.lastMsgType = Number(latestMessageForSummary.localType || 0)
        }
      }
      if (state.summary) {
        session.summary = state.summary
        session.lastMsgType = Number(state.lastMsgType || session.lastMsgType || 0)
      }
      session.unreadCount = Math.max(Number(session.unreadCount || 0), state.unreadCount)
    } catch (error) {
      console.warn(`[ChatService] 合成公众号未读失败: ${session.username}`, error)
    }
  }

  private getSessionSummaryFromMessage(message: Message): string {
    const cleanOfficialPrefix = (value: string): string => value.replace(/^\s*\[视频号\]\s*/u, '').trim()
    let summary = ''
    switch (Number(message.localType || 0)) {
      case 1:
        summary = message.parsedContent || message.rawContent || ''
        break
      case 3:
        summary = '[图片]'
        break
      case 34:
        summary = '[语音]'
        break
      case 43:
        summary = '[视频]'
        break
      case 47:
        summary = '[表情]'
        break
      case 42:
        summary = message.cardNickname || '[名片]'
        break
      case 48:
        summary = '[位置]'
        break
      case 49:
        summary = message.linkTitle || message.fileName || message.parsedContent || '[消息]'
        break
      default:
        summary = message.parsedContent || message.rawContent || getMessageTypeLabel(Number(message.localType || 0))
        break
    }
    return cleanOfficialPrefix(cleanString(summary))
  }

  private async getInitialSyntheticUnreadState(sessionId: string, latestTimestamp: number): Promise<{
    count: number
    latestMessage?: Message
  }> {
    const normalizedLatest = Number(latestTimestamp || 0)
    if (!Number.isFinite(normalizedLatest) || normalizedLatest <= 0) return { count: 0 }

    const nowSeconds = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSeconds - normalizedLatest) > 10 * 60) {
      return { count: 0 }
    }

    const result = await this.host.getNewMessages(sessionId, Math.max(0, Math.floor(normalizedLatest) - 1), 20)
    if (!result.success || !Array.isArray(result.messages)) return { count: 0 }
    const unreadMessages = result.messages.filter((message) => {
      const createTime = Number(message.createTime || 0)
      return Number.isFinite(createTime) &&
        createTime >= normalizedLatest &&
        message.isSend !== 1
    })
    return {
      count: unreadMessages.length,
      latestMessage: unreadMessages[unreadMessages.length - 1]
    }
  }
}
