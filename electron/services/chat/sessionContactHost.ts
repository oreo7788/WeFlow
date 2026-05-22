import type { ContactCacheEntry } from '../contactCacheService'
import type { Contact } from './types'

export interface SessionContactHost {
  ensureConnected(): Promise<{ success: boolean; error?: string }>
  getAvatarCacheEntry(username: string): ContactCacheEntry | undefined
  setAvatarCacheEntry(username: string, entry: ContactCacheEntry): void
  setContactCacheEntries(entries: Record<string, ContactCacheEntry>): void
  getAvatarCacheTtlMs(): number
  getContact(username: string): Promise<Contact | null>
  getMyWxidCleaned(): string
}
