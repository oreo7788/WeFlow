import { wcdbService } from '../wcdbService'
import type { ChatSession } from './types'
import type { AntiRevokeHost } from './antiRevokeHost'

export class AntiRevokeService {
  constructor(private readonly host: AntiRevokeHost) {}

  async checkAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.checkMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async installAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.installMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async uninstallAntiRevokeTriggers(sessionIds: string[]): Promise<{
    success: boolean
    rows?: Array<{ sessionId: string; success: boolean; error?: string }>
    error?: string
  }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) return { success: false, error: connectResult.error }
      const { validIds, invalidRows } = await this.filterAntiRevokeSessionIds(sessionIds)
      const result = validIds.length > 0
        ? await wcdbService.uninstallMessageAntiRevokeTriggers(validIds)
        : { success: true, rows: [] }
      if (!result.success) return result
      return { success: true, rows: [...(result.rows || []), ...invalidRows] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getAntiRevokeSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    try {
      const result = await this.host.getSessions()
      if (!result.success || !Array.isArray(result.sessions)) {
        return { success: false, error: result.error || '获取会话失败' }
      }

      return {
        success: true,
        sessions: result.sessions.filter((session) => !String(session.username || '').startsWith('gh_'))
      }
    } catch (e) {
      console.error('ChatService: 获取防撤回会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  private async filterAntiRevokeSessionIds(sessionIds: string[]): Promise<{
    validIds: string[]
    invalidRows: Array<{ sessionId: string; success: false; error: string }>
  }> {
    const normalizedIds = Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
    if (normalizedIds.length === 0) return { validIds: [], invalidRows: [] }

    const sessionsResult = await this.getAntiRevokeSessions()
    const allowedIds = new Set((sessionsResult.sessions || []).map((session) => session.username))
    const validIds = normalizedIds.filter((sessionId) => allowedIds.has(sessionId))
    const invalidRows = normalizedIds
      .filter((sessionId) => !allowedIds.has(sessionId))
      .map((sessionId) => ({
        sessionId,
        success: false as const,
        error: '该会话不是联系人或群聊，或不存在可安装防撤回的消息表'
      }))

    return { validIds, invalidRows }
  }
}
