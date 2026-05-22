import { basename, extname } from 'path'
import type { Message } from './types'
import { cleanAccountDirName } from './accountUtils'

export function compareMessagesByTimeline(a: Message, b: Message): number {
  const aSortSeq = Math.max(0, Number(a.sortSeq || 0))
  const bSortSeq = Math.max(0, Number(b.sortSeq || 0))
  const aCreateTime = Math.max(0, Number(a.createTime || 0))
  const bCreateTime = Math.max(0, Number(b.createTime || 0))
  const aLocalId = Math.max(0, Number(a.localId || 0))
  const bLocalId = Math.max(0, Number(b.localId || 0))
  const aServerId = Math.max(0, Number(a.serverId || 0))
  const bServerId = Math.max(0, Number(b.serverId || 0))

  if (aSortSeq > 0 && bSortSeq > 0 && aSortSeq !== bSortSeq) {
    return aSortSeq - bSortSeq
  }
  if (aCreateTime !== bCreateTime) {
    return aCreateTime - bCreateTime
  }
  if (aSortSeq !== bSortSeq) {
    return aSortSeq - bSortSeq
  }
  if (aLocalId !== bLocalId) {
    return aLocalId - bLocalId
  }
  if (aServerId !== bServerId) {
    return aServerId - bServerId
  }

  const aKey = String(a.messageKey || '')
  const bKey = String(b.messageKey || '')
  if (aKey < bKey) return -1
  if (aKey > bKey) return 1
  return 0
}

export function normalizeMessageOrder(messages: Message[]): Message[] {
  if (messages.length < 2) return messages

  const withIndex = messages.map((msg, index) => ({ msg, index }))
  withIndex.sort((left, right) => {
    const diff = compareMessagesByTimeline(left.msg, right.msg)
    if (diff !== 0) return diff
    return left.index - right.index
  })

  let changed = false
  for (let index = 0; index < withIndex.length; index += 1) {
    if (withIndex[index].msg !== messages[index]) {
      changed = true
      break
    }
  }
  if (!changed) return messages
  return withIndex.map((entry) => entry.msg)
}

export function encodeMessageKeySegment(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return encodeURIComponent(normalized)
}

export function getMessageSourceInfo(row: Record<string, any>): {
  dbName?: string
  tableName?: string
  dbPath?: string
} {
  const dbPath = String(row._db_path || row.db_path || '').trim()
  const explicitDbName = String(row.db_name || '').trim()
  const tableName = String(row.table_name || '').trim()
  const dbName = explicitDbName || (dbPath ? basename(dbPath, extname(dbPath)) : '')
  return {
    dbName: dbName || undefined,
    tableName: tableName || undefined,
    dbPath: dbPath || undefined
  }
}

export function buildMessageKey(input: {
  localId: number
  serverId: number
  createTime: number
  sortSeq: number
  senderUsername?: string | null
  localType: number
  dbName?: string
  tableName?: string
  dbPath?: string
}): string {
  const localId = Number.isFinite(input.localId) ? Math.max(0, Math.floor(input.localId)) : 0
  const serverId = Number.isFinite(input.serverId) ? Math.max(0, Math.floor(input.serverId)) : 0
  const createTime = Number.isFinite(input.createTime) ? Math.max(0, Math.floor(input.createTime)) : 0
  const sortSeq = Number.isFinite(input.sortSeq) ? Math.max(0, Math.floor(input.sortSeq)) : 0
  const localType = Number.isFinite(input.localType) ? Math.floor(input.localType) : 0
  const senderUsername = encodeMessageKeySegment(input.senderUsername || '')
  const dbPath = String(input.dbPath || '').trim()
  const dbName = String(input.dbName || '').trim() || (input.dbPath ? basename(input.dbPath, extname(input.dbPath)) : '')
  const tableName = String(input.tableName || '').trim()
  const sourceScope = dbPath || dbName

  if (localId > 0 && sourceScope && tableName) {
    return `${encodeMessageKeySegment(sourceScope)}:${encodeMessageKeySegment(tableName)}:${localId}`
  }

  if (localId > 0 && sourceScope) {
    return `local:${encodeMessageKeySegment(sourceScope)}:${localId}:${createTime}:${sortSeq}:${senderUsername}:${localType}`
  }

  if (serverId > 0) {
    const scopedServer = sourceScope ? `${encodeMessageKeySegment(sourceScope)}:${serverId}` : String(serverId)
    return `server:${scopedServer}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
  }

  return `fallback:${encodeMessageKeySegment(sourceScope)}:${createTime}:${sortSeq}:${localId}:${senderUsername}:${localType}`
}

export function getRowField(row: Record<string, any>, keys: string[]): any {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  const lowerMap = new Map<string, string>()
  for (const actual of Object.keys(row)) {
    lowerMap.set(actual.toLowerCase(), actual)
  }
  for (const key of keys) {
    const actual = lowerMap.get(key.toLowerCase())
    if (actual && row[actual] !== undefined && row[actual] !== null) {
      return row[actual]
    }
  }
  return undefined
}

export function coerceRowNumber(raw: any): number {
  if (raw === undefined || raw === null) return NaN
  if (typeof raw === 'number') return raw
  if (typeof raw === 'bigint') return Number(raw)
  if (Buffer.isBuffer(raw)) {
    return coerceRowNumber(raw.toString('utf-8'))
  }
  if (raw instanceof Uint8Array) {
    return coerceRowNumber(Buffer.from(raw).toString('utf-8'))
  }
  if (Array.isArray(raw)) {
    return coerceRowNumber(Buffer.from(raw).toString('utf-8'))
  }
  if (typeof raw === 'object') {
    if ('value' in raw) return coerceRowNumber(raw.value)
    if ('intValue' in raw) return coerceRowNumber(raw.intValue)
    if ('low' in raw && 'high' in raw) {
      try {
        const low = BigInt(raw.low >>> 0)
        const high = BigInt(raw.high >>> 0)
        return Number((high << 32n) + low)
      } catch {
        return NaN
      }
    }
    const text = raw.toString ? String(raw) : ''
    if (text && text !== '[object Object]') {
      return coerceRowNumber(text)
    }
    return NaN
  }
  const text = String(raw).trim()
  if (!text) return NaN
  if (/^[+-]?\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  if (/^[+-]?\d+\.\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

export function getRowInt(row: Record<string, any>, keys: string[], fallback = 0): number {
  const raw = getRowField(row, keys)
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = coerceRowNumber(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function parseCompactDateTimeDigitsToSeconds(raw: string): number {
  const text = String(raw || '').trim()
  if (!/^\d{8}(?:\d{4}(?:\d{2})?)?$/.test(text)) return 0

  const year = Number.parseInt(text.slice(0, 4), 10)
  const month = Number.parseInt(text.slice(4, 6), 10)
  const day = Number.parseInt(text.slice(6, 8), 10)
  const hour = text.length >= 12 ? Number.parseInt(text.slice(8, 10), 10) : 0
  const minute = text.length >= 12 ? Number.parseInt(text.slice(10, 12), 10) : 0
  const second = text.length >= 14 ? Number.parseInt(text.slice(12, 14), 10) : 0

  if (!Number.isFinite(year) || year < 1990 || year > 2200) return 0
  if (!Number.isFinite(month) || month < 1 || month > 12) return 0
  if (!Number.isFinite(day) || day < 1 || day > 31) return 0
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return 0
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return 0
  if (!Number.isFinite(second) || second < 0 || second > 59) return 0

  const dt = new Date(year, month - 1, day, hour, minute, second)
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute ||
    dt.getSeconds() !== second
  ) {
    return 0
  }
  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

export function parseDateTimeTextToSeconds(raw: unknown): number {
  const text = String(raw ?? '').trim()
  if (!text) return 0

  const compactDigits = parseCompactDateTimeDigitsToSeconds(text)
  if (compactDigits > 0) return compactDigits

  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text)
    const seconds = Math.floor(parsed / 1000)
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }

  const normalized = text.replace('T', ' ').replace(/\.\d+$/, '').replace(/\//g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (!match) return 0

  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4] || '0', 10)
  const minute = Number.parseInt(match[5] || '0', 10)
  const second = Number.parseInt(match[6] || '0', 10)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return 0
  const dt = new Date(year, month - 1, day, hour, minute, second)
  const ts = Math.floor(dt.getTime() / 1000)
  return Number.isFinite(ts) && ts > 0 ? ts : 0
}

export function normalizeTimestampLikeToSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0
  const text = String(raw ?? '').trim()
  if (!text) return 0

  const compactDigits = parseCompactDateTimeDigitsToSeconds(text)
  if (compactDigits > 0) return compactDigits

  const parsed = coerceRowNumber(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    let normalized = Math.floor(parsed)
    while (normalized > 10000000000) {
      normalized = Math.floor(normalized / 1000)
    }
    return normalized
  }

  return parseDateTimeTextToSeconds(text)
}

export function getRowTimestampSeconds(row: Record<string, any>, keys: string[], fallback = 0): number {
  const raw = getRowField(row, keys)
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = normalizeTimestampLikeToSeconds(raw)
  return parsed > 0 ? parsed : fallback
}

export function normalizeUnsignedIntegerToken(raw: any): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined

  if (typeof raw === 'bigint') {
    return raw >= 0n ? raw.toString() : '0'
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined
    return String(Math.max(0, Math.floor(raw)))
  }

  if (Buffer.isBuffer(raw)) {
    return normalizeUnsignedIntegerToken(raw.toString('utf-8').trim())
  }
  if (raw instanceof Uint8Array) {
    return normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
  }
  if (Array.isArray(raw)) {
    return normalizeUnsignedIntegerToken(Buffer.from(raw).toString('utf-8').trim())
  }

  if (typeof raw === 'object') {
    if ('value' in raw) return normalizeUnsignedIntegerToken(raw.value)
    if ('intValue' in raw) return normalizeUnsignedIntegerToken(raw.intValue)
    if ('low' in raw && 'high' in raw) {
      try {
        const low = BigInt(raw.low >>> 0)
        const high = BigInt(raw.high >>> 0)
        const value = (high << 32n) + low
        return value >= 0n ? value.toString() : '0'
      } catch {
        return undefined
      }
    }
    const text = raw.toString ? String(raw).trim() : ''
    if (text && text !== '[object Object]') {
      return normalizeUnsignedIntegerToken(text)
    }
    return undefined
  }

  const text = String(raw).trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) {
    return text.replace(/^0+(?=\d)/, '') || '0'
  }
  if (/^[+-]?\d+$/.test(text)) {
    try {
      const value = BigInt(text)
      return value >= 0n ? value.toString() : '0'
    } catch {
      return undefined
    }
  }

  const parsed = Number(text)
  if (Number.isFinite(parsed)) {
    return String(Math.max(0, Math.floor(parsed)))
  }
  return undefined
}

export function buildIdentityKeys(raw: string): string[] {
  const value = String(raw || '').trim()
  if (!value) return []
  const lowerRaw = value.toLowerCase()
  const cleaned = cleanAccountDirName(value).toLowerCase()
  if (cleaned && cleaned !== lowerRaw) {
    return [cleaned, lowerRaw]
  }
  return [lowerRaw]
}

export function resolveMessageIsSend(
  rawIsSend: number | null,
  senderUsername: string | null | undefined,
  myWxid: string
): {
  isSend: number | null
  selfMatched: boolean
  correctedBySelfIdentity: boolean
} {
  const normalizedRawIsSend = Number.isFinite(rawIsSend as number) ? rawIsSend : null
  const senderKeys = buildIdentityKeys(String(senderUsername || ''))
  if (senderKeys.length === 0) {
    return {
      isSend: normalizedRawIsSend,
      selfMatched: false,
      correctedBySelfIdentity: false
    }
  }

  const selfKeys = buildIdentityKeys(String(myWxid || '').trim())
  if (selfKeys.length === 0) {
    return {
      isSend: normalizedRawIsSend,
      selfMatched: false,
      correctedBySelfIdentity: false
    }
  }

  const selfMatched = senderKeys.some(senderKey =>
    selfKeys.some(selfKey =>
      senderKey === selfKey ||
      senderKey.startsWith(selfKey + '_') ||
      selfKey.startsWith(senderKey + '_')
    )
  )

  if (selfMatched && normalizedRawIsSend !== 1) {
    return {
      isSend: 1,
      selfMatched: true,
      correctedBySelfIdentity: true
    }
  }

  if (normalizedRawIsSend === null) {
    return {
      isSend: selfMatched ? 1 : 0,
      selfMatched,
      correctedBySelfIdentity: false
    }
  }

  return {
    isSend: normalizedRawIsSend,
    selfMatched,
    correctedBySelfIdentity: false
  }
}
