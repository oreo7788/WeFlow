import { wcdbService } from '../wcdbService'
import type { Message } from './types'
import type { MessageParseService } from './messageParseService'

export class MessageQueryService {
  constructor(private readonly parseService: MessageParseService) {}

  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      const nativeResult = await wcdbService.getMessageById(sessionId, localId)
      if (nativeResult.success && nativeResult.message) {
        const message = await this.parseService.parseMessage(nativeResult.message as Record<string, any>, { source: 'detail', sessionId })
        if (message.localId !== 0) return { success: true, message }
      }
      return { success: false, error: nativeResult.error || '未找到消息' }
    } catch (e) {
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
    try {
      const result = await wcdbService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
      if (!result.success || !result.messages) {
        return { success: false, error: result.error || '搜索失败' }
      }
      const messages: Message[] = []
      const isGroupSearch = Boolean(String(sessionId || '').trim().endsWith('@chatroom'))

      for (const row of result.messages) {
        let message = await this.parseService.parseMessage(row, { source: 'search', sessionId })
        const resolvedSessionId = String(sessionId || row._session_id || '').trim()
        const needsDetailHydration = isGroupSearch &&
          Boolean(sessionId) &&
          message.localId > 0 &&
          (!message.senderUsername || message.isSend === null)

        if (needsDetailHydration && sessionId) {
          const detail = await this.getMessageById(sessionId, message.localId)
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

      return { success: true, messages }
    } catch (e) {
      console.error('ChatService: searchMessages 失败:', e)
      return { success: false, error: String(e) }
    }
  }
}
