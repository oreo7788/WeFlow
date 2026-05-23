export function normalizeSearchIdentityText(value?: string | null): string | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  if (normalized === '未知' || lower === 'unknown' || lower === 'null' || lower === 'undefined') {
    return undefined
  }
  if (lower.startsWith('unknown_sender_')) {
    return undefined
  }
  return normalized
}

function isWxidLikeSearchIdentity(value?: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return false
  if (normalized.startsWith('wxid_')) return true
  const suffixMatch = normalized.match(/^(.+)_([a-z0-9]{4})$/i)
  return Boolean(suffixMatch && suffixMatch[1].startsWith('wxid_'))
}

export function resolveSearchSenderDisplayName(
  displayName?: string | null,
  senderUsername?: string | null,
  sessionId?: string | null
): string | undefined {
  const normalizedDisplayName = normalizeSearchIdentityText(displayName)
  if (!normalizedDisplayName) return undefined

  const normalizedSenderUsername = normalizeSearchIdentityText(senderUsername)
  const normalizedSessionId = normalizeSearchIdentityText(sessionId)

  if (normalizedSessionId && normalizedDisplayName === normalizedSessionId) {
    return undefined
  }
  if (isWxidLikeSearchIdentity(normalizedDisplayName)) {
    return undefined
  }
  if (
    normalizedSenderUsername &&
    normalizedDisplayName === normalizedSenderUsername &&
    isWxidLikeSearchIdentity(normalizedSenderUsername)
  ) {
    return undefined
  }

  return normalizedDisplayName
}

export function resolveSearchSenderUsernameFallback(value?: string | null): string | undefined {
  const normalized = normalizeSearchIdentityText(value)
  if (!normalized || isWxidLikeSearchIdentity(normalized)) {
    return undefined
  }
  return normalized
}

function buildSearchIdentityCandidates(value?: string | null): string[] {
  const normalized = normalizeSearchIdentityText(value)
  if (!normalized) return []
  const lower = normalized.toLowerCase()
  const candidates = new Set<string>([lower])
  if (lower.startsWith('wxid_')) {
    const match = lower.match(/^(wxid_[^_]+)/i)
    if (match?.[1]) {
      candidates.add(match[1])
    }
  }
  return [...candidates]
}

export function isCurrentUserSearchIdentity(
  senderUsername?: string | null,
  myWxid?: string | null
): boolean {
  const senderCandidates = buildSearchIdentityCandidates(senderUsername)
  const selfCandidates = buildSearchIdentityCandidates(myWxid)
  if (senderCandidates.length === 0 || selfCandidates.length === 0) {
    return false
  }

  for (const sender of senderCandidates) {
    for (const self of selfCandidates) {
      if (sender === self) return true
      if (sender.startsWith(self + '_')) return true
      if (self.startsWith(sender + '_')) return true
    }
  }
  return false
}

export type GroupMessageCountStatus = 'loading' | 'ready' | 'failed'

export interface GroupPanelMember {
  username: string
  displayName: string
  avatarUrl?: string
  nickname?: string
  alias?: string
  remark?: string
  groupNickname?: string
  isOwner?: boolean
  isFriend: boolean
  messageCount: number
  messageCountStatus: GroupMessageCountStatus
}

const QUOTED_SENDER_CACHE_TTL_MS = 10 * 60 * 1000
const quotedSenderDisplayCache = new Map<string, { displayName: string; updatedAt: number }>()
const quotedSenderDisplayLoading = new Map<string, Promise<string | undefined>>()
const quotedGroupMembersCache = new Map<string, { members: GroupPanelMember[]; updatedAt: number }>()
const quotedGroupMembersLoading = new Map<string, Promise<GroupPanelMember[]>>()

function buildQuotedSenderCacheKey(
  sessionId: string,
  senderUsername: string,
  isGroupChat: boolean
): string {
  const normalizedSessionId = normalizeSearchIdentityText(sessionId) || String(sessionId || '').trim()
  const normalizedSender = normalizeSearchIdentityText(senderUsername) || String(senderUsername || '').trim()
  return `${isGroupChat ? 'group' : 'direct'}::${normalizedSessionId}::${normalizedSender}`
}

function isSameQuotedSenderIdentity(left?: string | null, right?: string | null): boolean {
  const leftCandidates = buildSearchIdentityCandidates(left)
  const rightCandidates = buildSearchIdentityCandidates(right)
  if (leftCandidates.length === 0 || rightCandidates.length === 0) {
    return false
  }

  for (const leftCandidate of leftCandidates) {
    for (const rightCandidate of rightCandidates) {
      if (leftCandidate === rightCandidate) return true
      if (leftCandidate.startsWith(rightCandidate + '_')) return true
      if (rightCandidate.startsWith(leftCandidate + '_')) return true
    }
  }

  return false
}

function normalizeQuotedGroupMember(member: Partial<GroupPanelMember> | null | undefined): GroupPanelMember | null {
  const username = String(member?.username || '').trim()
  if (!username) return null

  const displayName = String(member?.displayName || '').trim()
  const nickname = String(member?.nickname || '').trim()
  const remark = String(member?.remark || '').trim()
  const alias = String(member?.alias || '').trim()
  const groupNickname = String(member?.groupNickname || '').trim()

  return {
    username,
    displayName: displayName || groupNickname || remark || nickname || alias || username,
    avatarUrl: member?.avatarUrl,
    nickname,
    alias,
    remark,
    groupNickname,
    isOwner: Boolean(member?.isOwner),
    isFriend: Boolean(member?.isFriend),
    messageCount: Number.isFinite(member?.messageCount) ? Math.max(0, Math.floor(member?.messageCount as number)) : 0,
    messageCountStatus: 'ready'
  }
}

export function resolveQuotedSenderFallbackDisplayName(
  sessionId: string,
  senderUsername?: string | null,
  fallbackDisplayName?: string | null
): string | undefined {
  const resolved = resolveSearchSenderDisplayName(fallbackDisplayName, senderUsername, sessionId)
  if (resolved) return resolved
  return resolveSearchSenderUsernameFallback(senderUsername)
}

export function resolveQuotedSenderUsername(
  fromusr?: string | null,
  chatusr?: string | null
): string {
  const normalizedChatUsr = String(chatusr || '').trim()
  const normalizedFromUsr = String(fromusr || '').trim()

  if (normalizedChatUsr) {
    return normalizedChatUsr
  }

  if (normalizedFromUsr.endsWith('@chatroom')) {
    return ''
  }

  return normalizedFromUsr
}

function resolveQuotedGroupMemberDisplayName(member: GroupPanelMember): string | undefined {
  const remark = normalizeSearchIdentityText(member.remark)
  if (remark) return remark

  const groupNickname = normalizeSearchIdentityText(member.groupNickname)
  if (groupNickname) return groupNickname

  const nickname = normalizeSearchIdentityText(member.nickname)
  if (nickname) return nickname

  const displayName = resolveSearchSenderDisplayName(member.displayName, member.username)
  if (displayName) return displayName

  const alias = normalizeSearchIdentityText(member.alias)
  if (alias) return alias

  return resolveSearchSenderUsernameFallback(member.username)
}

function resolveQuotedPrivateDisplayName(contact: any): string | undefined {
  const remark = normalizeSearchIdentityText(contact?.remark)
  if (remark) return remark

  const nickname = normalizeSearchIdentityText(
    contact?.nickName || contact?.nick_name || contact?.nickname
  )
  if (nickname) return nickname

  const alias = normalizeSearchIdentityText(contact?.alias)
  if (alias) return alias

  return undefined
}

async function getQuotedGroupMembers(chatroomId: string): Promise<GroupPanelMember[]> {
  const normalizedChatroomId = String(chatroomId || '').trim()
  if (!normalizedChatroomId || !normalizedChatroomId.includes('@chatroom')) {
    return []
  }

  const cached = quotedGroupMembersCache.get(normalizedChatroomId)
  if (cached && Date.now() - cached.updatedAt < QUOTED_SENDER_CACHE_TTL_MS) {
    return cached.members
  }

  const pending = quotedGroupMembersLoading.get(normalizedChatroomId)
  if (pending) return pending

  const request = window.electronAPI.groupAnalytics.getGroupMembersPanelData(
    normalizedChatroomId,
    { forceRefresh: false, includeMessageCounts: false }
  ).then((result) => {
    const members = Array.isArray(result.data)
      ? result.data
        .map((member) => normalizeQuotedGroupMember(member as Partial<GroupPanelMember>))
        .filter((member): member is GroupPanelMember => Boolean(member))
      : []

    if (members.length > 0) {
      quotedGroupMembersCache.set(normalizedChatroomId, {
        members,
        updatedAt: Date.now()
      })
      return members
    }

    return cached?.members || []
  }).catch(() => cached?.members || []).finally(() => {
    quotedGroupMembersLoading.delete(normalizedChatroomId)
  })

  quotedGroupMembersLoading.set(normalizedChatroomId, request)
  return request
}

export async function resolveQuotedSenderDisplayName(options: {
  sessionId: string
  senderUsername?: string | null
  fallbackDisplayName?: string | null
  isGroupChat?: boolean
  myWxid?: string | null
}): Promise<string | undefined> {
  const normalizedSessionId = String(options.sessionId || '').trim()
  const normalizedSender = String(options.senderUsername || '').trim()
  const fallbackDisplayName = resolveQuotedSenderFallbackDisplayName(
    normalizedSessionId,
    normalizedSender,
    options.fallbackDisplayName
  )

  if (!normalizedSender) {
    return fallbackDisplayName
  }

  const cacheKey = buildQuotedSenderCacheKey(normalizedSessionId, normalizedSender, Boolean(options.isGroupChat))
  const cached = quotedSenderDisplayCache.get(cacheKey)
  if (cached && Date.now() - cached.updatedAt < QUOTED_SENDER_CACHE_TTL_MS) {
    return cached.displayName
  }

  const pending = quotedSenderDisplayLoading.get(cacheKey)
  if (pending) return pending

  const request = (async (): Promise<string | undefined> => {
    if (options.isGroupChat) {
      const members = await getQuotedGroupMembers(normalizedSessionId)
      const matchedMember = members.find((member) => isSameQuotedSenderIdentity(member.username, normalizedSender))
      const groupDisplayName = matchedMember ? resolveQuotedGroupMemberDisplayName(matchedMember) : undefined
      if (groupDisplayName) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: groupDisplayName,
          updatedAt: Date.now()
        })
        return groupDisplayName
      }
    }

    if (isCurrentUserSearchIdentity(normalizedSender, options.myWxid)) {
      const selfDisplayName = fallbackDisplayName || '我'
      quotedSenderDisplayCache.set(cacheKey, {
        displayName: selfDisplayName,
        updatedAt: Date.now()
      })
      return selfDisplayName
    }

    try {
      const contact = await window.electronAPI.chat.getContact(normalizedSender)
      const contactDisplayName = resolveQuotedPrivateDisplayName(contact)
      if (contactDisplayName) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: contactDisplayName,
          updatedAt: Date.now()
        })
        return contactDisplayName
      }
    } catch {
      // ignore contact lookup failures and fall back below
    }

    try {
      const profile = await window.electronAPI.chat.getContactAvatar(normalizedSender)
      const profileDisplayName = normalizeSearchIdentityText(profile?.displayName)
      if (profileDisplayName && !isWxidLikeSearchIdentity(profileDisplayName)) {
        quotedSenderDisplayCache.set(cacheKey, {
          displayName: profileDisplayName,
          updatedAt: Date.now()
        })
        return profileDisplayName
      }
    } catch {
      // ignore avatar lookup failures and keep fallback usable
    }

    if (fallbackDisplayName) {
      quotedSenderDisplayCache.set(cacheKey, {
        displayName: fallbackDisplayName,
        updatedAt: Date.now()
      })
    }

    return fallbackDisplayName
  })().finally(() => {
    quotedSenderDisplayLoading.delete(cacheKey)
  })

  quotedSenderDisplayLoading.set(cacheKey, request)
  return request
}

export function clearQuotedSenderDisplayCache(): void {
  quotedSenderDisplayCache.clear()
  quotedSenderDisplayLoading.clear()
  quotedGroupMembersCache.clear()
  quotedGroupMembersLoading.clear()
}
