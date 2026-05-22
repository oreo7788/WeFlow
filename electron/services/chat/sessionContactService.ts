import { wcdbService } from '../wcdbService'
import { cleanAccountDirName } from './accountUtils'
import type { ContactCacheEntry } from '../contactCacheService'
import type { SessionContactHost } from './sessionContactHost'

export function isValidAvatarUrl(avatarUrl?: string): avatarUrl is string {
  const normalized = String(avatarUrl || '').trim()
  if (!normalized) return false
  const normalizedLower = normalized.toLowerCase()
  if (normalizedLower.includes('base64,ffd8')) return false
  if (normalizedLower.startsWith('ffd8')) return false
  return true
}

export class SessionContactService {
  constructor(private readonly host: SessionContactHost) {}

  async enrichSessionsContactInfo(
    usernames: string[],
    options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
  ): Promise<{
    success: boolean
    contacts?: Record<string, { displayName?: string; avatarUrl?: string }>
    error?: string
  }> {
    try {
      const normalizedUsernames = Array.from(
        new Set(
          (usernames || [])
            .map((username) => String(username || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedUsernames.length === 0) {
        return { success: true, contacts: {} }
      }
      const skipDisplayName = options?.skipDisplayName === true
      const onlyMissingAvatar = options?.onlyMissingAvatar === true

      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const now = Date.now()
      const ttlMs = this.host.getAvatarCacheTtlMs()
      const missing: string[] = []
      const result: Record<string, { displayName?: string; avatarUrl?: string }> = {}
      const updatedEntries: Record<string, ContactCacheEntry> = {}

      for (const username of normalizedUsernames) {
        const cached = this.host.getAvatarCacheEntry(username)
        const cachedAvatarUrl = isValidAvatarUrl(cached?.avatarUrl) ? cached?.avatarUrl : undefined
        if (onlyMissingAvatar && cachedAvatarUrl) {
          result[username] = {
            displayName: skipDisplayName ? undefined : cached?.displayName,
            avatarUrl: cachedAvatarUrl
          }
          continue
        }
        if (cached && now - cached.updatedAt < ttlMs && isValidAvatarUrl(cached?.avatarUrl)) {
          result[username] = {
            displayName: skipDisplayName ? undefined : cached.displayName,
            avatarUrl: cachedAvatarUrl
          }
        } else {
          missing.push(username)
        }
      }

      if (missing.length > 0) {
        const displayNames = skipDisplayName
          ? null
          : await wcdbService.getDisplayNames(missing)
        const avatarUrls = await wcdbService.getAvatarUrls(missing)
        const missingAvatars: string[] = []

        for (const username of missing) {
          const previous = this.host.getAvatarCacheEntry(username)
          const displayName = displayNames?.success && displayNames.map
            ? displayNames.map[username]
            : undefined
          let avatarUrl = avatarUrls.success && avatarUrls.map ? avatarUrls.map[username] : undefined

          if (!avatarUrl) {
            missingAvatars.push(username)
          }

          const cacheEntry: ContactCacheEntry = {
            displayName: displayName || previous?.displayName || username,
            avatarUrl,
            updatedAt: now
          }
          result[username] = {
            displayName: skipDisplayName ? undefined : (displayName || previous?.displayName),
            avatarUrl
          }
          this.host.setAvatarCacheEntry(username, cacheEntry)
          updatedEntries[username] = cacheEntry
        }

        if (missingAvatars.length > 0) {
          const headImageAvatars = await this.getAvatarsFromHeadImageDb(missingAvatars)
          for (const username of missingAvatars) {
            const avatarUrl = headImageAvatars[username]
            if (avatarUrl) {
              result[username].avatarUrl = avatarUrl
              const cached = this.host.getAvatarCacheEntry(username)
              if (cached) {
                cached.avatarUrl = avatarUrl
                updatedEntries[username] = cached
              }
            }
          }
        }

        if (Object.keys(updatedEntries).length > 0) {
          this.host.setContactCacheEntries(updatedEntries)
        }
      }
      return { success: true, contacts: result }
    } catch (e) {
      console.error('ChatService: 补充联系人信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  async getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    if (usernames.length === 0) return result

    try {
      const normalizedUsernames = Array.from(
        new Set(
          usernames
            .map((username) => String(username || '').trim())
            .filter(Boolean)
        )
      )
      if (normalizedUsernames.length === 0) return result

      const batchSize = 320
      for (let i = 0; i < normalizedUsernames.length; i += batchSize) {
        const batch = normalizedUsernames.slice(i, i + batchSize)
        if (batch.length === 0) continue

        const queryResult = await wcdbService.getHeadImageBuffers(batch)
        if (!queryResult.success || !queryResult.map) continue

        for (const [username, rawHex] of Object.entries(queryResult.map)) {
          const hex = String(rawHex || '').trim()
          if (!username || !hex) continue
          try {
            const base64Data = Buffer.from(hex, 'hex').toString('base64')
            if (base64Data) {
              result[username] = `data:image/jpeg;base64,${base64Data}`
            }
          } catch {
            // ignore invalid blob hex
          }
        }
      }
    } catch (e) {
      console.error('从 head_image.db 获取头像失败:', e)
    }

    return result
  }

  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string } | null> {
    if (!username) return null

    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) return null
      const cached = this.host.getAvatarCacheEntry(username)
      const ttlMs = this.host.getAvatarCacheTtlMs()
      if (cached && isValidAvatarUrl(cached?.avatarUrl) && Date.now() - cached.updatedAt < ttlMs) {
        return { avatarUrl: cached.avatarUrl, displayName: cached.displayName }
      }

      const contact = await this.host.getContact(username)
      const avatarResult = await wcdbService.getAvatarUrls([username])
      let avatarUrl = avatarResult.success && avatarResult.map ? avatarResult.map[username] : undefined
      if (!isValidAvatarUrl(avatarUrl)) {
        avatarUrl = undefined
      }
      if (!avatarUrl) {
        const headImageAvatars = await this.getAvatarsFromHeadImageDb([username])
        const fallbackAvatarUrl = headImageAvatars[username]
        if (isValidAvatarUrl(fallbackAvatarUrl)) {
          avatarUrl = fallbackAvatarUrl
        }
      }
      const displayName = contact?.remark || contact?.nickName || contact?.alias || cached?.displayName || username
      const cacheEntry: ContactCacheEntry = {
        avatarUrl,
        displayName,
        updatedAt: Date.now()
      }
      this.host.setAvatarCacheEntry(username, cacheEntry)
      this.host.setContactCacheEntries({ [username]: cacheEntry })
      return { avatarUrl, displayName }
    } catch {
      return null
    }
  }

  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { payerName: payerUsername, receiverName: receiverUsername }
      }

      const groupNicknames = new Map<string, string>()
      if (chatroomId.endsWith('@chatroom')) {
        const nickResult = await wcdbService.getGroupNicknames(chatroomId)
        if (nickResult.success && nickResult.nicknames) {
          const nicknameBuckets = new Map<string, Set<string>>()
          for (const [memberIdRaw, nicknameRaw] of Object.entries(nickResult.nicknames)) {
            const memberId = String(memberIdRaw || '').trim().toLowerCase()
            const nickname = String(nicknameRaw || '').trim()
            if (!memberId || !nickname) continue
            const slot = nicknameBuckets.get(memberId)
            if (slot) {
              slot.add(nickname)
            } else {
              nicknameBuckets.set(memberId, new Set([nickname]))
            }
          }
          for (const [memberId, nicknameSet] of nicknameBuckets.entries()) {
            if (nicknameSet.size !== 1) continue
            groupNicknames.set(memberId, Array.from(nicknameSet)[0])
          }
        }
      }

      const lookupGroupNickname = (username?: string | null): string => {
        const key = String(username || '').trim().toLowerCase()
        if (!key) return ''
        return groupNicknames.get(key) || ''
      }

      const myWxid = this.host.getMyWxidCleaned()
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const resolveName = async (username: string): Promise<string> => {
        if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
          const myGroupNick = lookupGroupNickname(username) || lookupGroupNickname(myWxid)
          if (myGroupNick) return myGroupNick
          const cached = this.host.getAvatarCacheEntry(username) || this.host.getAvatarCacheEntry(myWxid)
          if (cached?.displayName) return cached.displayName
          return '我'
        }

        const groupNick = lookupGroupNickname(username)
        if (groupNick) return groupNick

        const contact = await this.host.getContact(username)
        if (contact) {
          return contact.remark || contact.nickName || contact.alias || username
        }

        const cached = this.host.getAvatarCacheEntry(username)
        if (cached?.displayName) return cached.displayName

        return username
      }

      const [payerName, receiverName] = await Promise.all([
        resolveName(payerUsername),
        resolveName(receiverUsername)
      ])

      return { payerName, receiverName }
    } catch {
      return { payerName: payerUsername, receiverName: receiverUsername }
    }
  }

  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error }
      }

      const myWxid = this.host.getMyWxidCleaned()
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const cleanedWxid = cleanAccountDirName(myWxid)
      const fetchList = Array.from(new Set([myWxid, cleanedWxid, 'self']))
      const result = await wcdbService.getAvatarUrls(fetchList)

      if (result.success && result.map) {
        const avatarUrl = result.map[myWxid] || result.map[cleanedWxid] || result.map['self']
        if (avatarUrl) {
          return { success: true, avatarUrl }
        }
        return { success: true, avatarUrl: undefined }
      }

      return { success: true, avatarUrl: undefined }
    } catch (e) {
      console.error('ChatService: 获取当前用户头像失败:', e)
      return { success: false, error: String(e) }
    }
  }
}
