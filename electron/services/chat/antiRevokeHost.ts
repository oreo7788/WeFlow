import type { ChatSession } from './types'

export interface AntiRevokeHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
}
