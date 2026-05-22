import { wcdbService } from '../wcdbService'
import { getRowInt } from './messageRowUtils'

export class SessionFilterService {
  getSessionLocalType(row: Record<string, any>): number | undefined {
    const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
    return Number.isFinite(localType) ? Math.floor(localType) : undefined
  }

  async loadContactLocalTypeMapForEnterpriseOpenim(usernames: string[]): Promise<Map<string, number>> {
    const normalizedUsernames = Array.from(new Set(
      (usernames || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && this.isEnterpriseOpenimUsername(value))
    ))
    const localTypeMap = new Map<string, number>()
    if (normalizedUsernames.length === 0) {
      return localTypeMap
    }
    try {
      const contactResult = await wcdbService.getContactsCompact(normalizedUsernames)
      if (!contactResult.success || !Array.isArray(contactResult.contacts)) {
        return localTypeMap
      }
      for (const row of contactResult.contacts as Record<string, any>[]) {
        const username = String(row.username || '').trim()
        if (!username) continue
        const localType = getRowInt(row, ['local_type', 'localType', 'WCDB_CT_local_type'], Number.NaN)
        if (!Number.isFinite(localType)) continue
        localTypeMap.set(username, Math.floor(localType))
      }
    } catch {
      return localTypeMap
    }
    return localTypeMap
  }

  isEnterpriseOpenimUsername(username: string): boolean {
    const lowered = String(username || '').trim().toLowerCase()
    return lowered.includes('@openim') && !lowered.includes('@kefu.openim')
  }

  isAllowedEnterpriseOpenimByLocalType(username: string, localType?: number): boolean {
    if (!this.isEnterpriseOpenimUsername(username)) return false
    return Number.isFinite(localType) && Math.floor(localType as number) === 5
  }

  shouldKeepSession(username: string, localType?: number): boolean {
    if (!username) return false
    const lowered = username.toLowerCase()
    if (lowered.includes('@placeholder')) return false
    if (username.startsWith('gh_')) return false
    if (lowered === 'weixin') return false

    const excludeList = [
      'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders',
      '@helper_folders'
    ]

    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    if (username.includes('@kefu.openim')) return false
    if (this.isEnterpriseOpenimUsername(username)) {
      return this.isAllowedEnterpriseOpenimByLocalType(username, localType)
    }
    if (username.includes('service_')) return false

    return true
  }

  escapeSqlString(value: string): string {
    return value.replace(/'/g, "''")
  }

  quoteSqlIdentifier(identifier: string): string {
    return `"${String(identifier || '').replace(/"/g, '""')}"`
  }
}
