import type { ChatSession, Contact, Message, MyFootprintData } from './types'

export interface MyFootprintHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getMyWxidCleaned(): string
  getConfig(key: string): unknown
  getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
  getSessionMessageTables(sessionId: string): Promise<Array<{ tableName: string; dbPath: string }>>
  getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }>
  parseMessage(row: any, options?: { source?: 'search' | 'detail'; sessionId?: string }): Promise<Message>
  enrichSessionsContactInfo(
    usernames: string[],
    options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
  ): Promise<{ success: boolean; contacts?: Record<string, { displayName?: string; avatarUrl?: string }>; error?: string }>
  quoteSqlIdentifier(identifier: string): string
  getSessionLocalType(row: Record<string, unknown>): number | undefined
  loadContactLocalTypeMapForEnterpriseOpenim(usernames: string[]): Promise<Map<string, number>>
  isEnterpriseOpenimUsername(username: string): boolean
  shouldKeepSession(username: string, localType?: number): boolean
  escapeSqlString(value: string): string
  resolveMessageSenderUsernameById(dbPath: string, senderId: unknown): Promise<string | null>
}

export type MyFootprintStatsOptions = {
  myWxid?: string
  privateSessionIds?: string[]
  groupSessionIds?: string[]
  mentionLimit?: number
  privateLimit?: number
  mentionMode?: 'text_at_me' | string
}

export type { MyFootprintData }
