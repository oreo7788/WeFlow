import type { ContactCacheEntry } from '../contactCacheService'
import type { ChatSession, Message } from './types'

export interface SessionListHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  refreshSessionMessageCountCacheScope(): void
  getMyWxidCleaned(): string
  loadContactLocalTypeMapForEnterpriseOpenim(usernames: string[]): Promise<Map<string, number>>
  getSessionLocalType(row: Record<string, any>): number | undefined
  shouldKeepSession(username: string, localType?: number): boolean
  isEnterpriseOpenimUsername(username: string): boolean
  isAllowedEnterpriseOpenimByLocalType(username: string, localType?: number): boolean
  getAvatarCacheEntry(username: string): ContactCacheEntry | undefined
  applyCachedStatusToSession(session: ChatSession, username: string, now?: number): void
  seedMessageCountHint(username: string, messageCountHint: number | undefined): void
  setMessageCountHint(username: string, count: number): void
  getNewMessages(sessionId: string, minTime: number, limit: number): Promise<{ success: boolean; messages?: Message[]; error?: string }>
  notifySessionsEnriched(sessions: ChatSession[]): void
}
