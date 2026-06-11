import { wcdbService } from '../wcdbService'
import type { Message } from './types'
import type { MessageParseService } from './messageParseService'
import { logPerf, nowMs } from '../../utils/perfLogger'

export class MessageQueryService {
  constructor(private readonly parseService: MessageParseService) {}

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    const startedAt = nowMs()
    try {
      const nativeResult = await wcdbService.getMessageById(sessionId, localId)
      if (nativeResult.success && nativeResult.message) {
        const message = await this.parseService.parseMessage(nativeResult.message as Record<string, any>, { source: 'detail', sessionId })
        if (message.localId !== 0) {
          logPerf('messageQuery', 'getMessageById', nowMs() - startedAt, {
            sessionId,
            localId
          })
          return { success: true, message }
        }
      }
      logPerf('messageQuery', 'getMessageById.miss', nowMs() - startedAt, {
        sessionId,
        localId
      })
      return { success: false, error: nativeResult.error || '未找到消息' }
    } catch (e) {
      logPerf('messageQuery', 'getMessageById.error', nowMs() - startedAt, {
        sessionId,
        localId
      })
      console.error('ChatService: getMessageById 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async searchMessages(
    keyword: string,
    sessionId?: string,
    limit?: number,
    offset?: number,
    beginTimestamp?: number,
    endTimestamp?: number
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const startedAt = nowMs()
    try {
      const nativeStartedAt = nowMs()
      const result = await wcdbService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
      const nativeMs = nowMs() - nativeStartedAt
      if (!result.success || !result.messages) {
        logPerf('messageQuery', 'searchMessages.nativeFailed', nowMs() - startedAt, {
          keywordLength: keyword.length,
          sessionId: sessionId || '',
          limit: limit || 0,
          offset: offset || 0,
          nativeMs
        })
        return { success: false, error: result.error || '搜索失败' }
      }
      const messages: Message[] = []
      const isGroupSearch = Boolean(String(sessionId || '').trim().endsWith('@chatroom'))
      let hydrationCount = 0
      let hydrationMs = 0
      let parseMs = 0

      for (const row of result.messages) {
        const parseStartedAt = nowMs()
        let message = await this.parseService.parseMessage(row, { source: 'search', sessionId })
        parseMs += nowMs() - parseStartedAt
        const resolvedSessionId = String(sessionId || row._session_id || '').trim()
        const needsDetailHydration = isGroupSearch &&
          Boolean(sessionId) &&
          message.localId > 0 &&
          (!message.senderUsername || message.isSend === null)

        if (needsDetailHydration && sessionId) {
          const hydrateStartedAt = nowMs()
          const detail = await this.getMessageById(sessionId, message.localId)
          hydrationMs += nowMs() - hydrateStartedAt
          hydrationCount += 1
          if (detail.success && detail.message) {
            message = {
              ...message,
              ...detail.message,
              parsedContent: message.parsedContent || detail.message.parsedContent,
              rawContent: message.rawContent || detail.message.rawContent,
              content: message.content || detail.message.content
            }
          }
        }

        if (resolvedSessionId) {
          ;(message as Message & { sessionId?: string }).sessionId = resolvedSessionId
        }
        messages.push(message)
      }

      logPerf('messageQuery', 'searchMessages', nowMs() - startedAt, {
        keywordLength: keyword.length,
        sessionId: sessionId || '',
        limit: limit || 0,
        offset: offset || 0,
        nativeMs,
        parseMs,
        hydrationMs,
        hydrationCount,
        returned: messages.length
      })
      return { success: true, messages }
    } catch (e) {
      logPerf('messageQuery', 'searchMessages.error', nowMs() - startedAt, {
        keywordLength: keyword.length,
        sessionId: sessionId || '',
        limit: limit || 0,
        offset: offset || 0
      })
      console.error('ChatService: searchMessages 失败:', e)
      return { success: false, error: String(e) }
    }
  }
}
