import { wcdbService } from '../wcdbService'
import {
  buildMessageKey,
  getMessageSourceInfo,
  getRowInt,
  getRowTimestampSeconds,
  normalizeUnsignedIntegerToken,
  resolveMessageIsSend
} from './messageRowUtils'
import {
  decodeMessageContent,
  extractSenderUsernameFromContent,
  parseCardInfo,
  parseEmojiInfo,
  parseImageDatNameFromRow,
  parseImageInfo,
  parseMessageContent,
  parseType49Message,
  parseVideoFileNameFromRow
} from './messageParsing'
import type { Message } from './types'
import type { MessageParseHost } from './messageParseHost'

export class MessageParseService {
  private messageName2IdTableCache = new Map<string, string | null>()
  private messageSenderIdCache = new Map<string, string | null>()

  constructor(private readonly host: MessageParseHost) {}

  async resolveMessageSenderUsernameById(dbPath: string, senderId: unknown): Promise<string | null> {
    const normalizedDbPath = String(dbPath || '').trim()
    const numericSenderId = Number.parseInt(String(senderId ?? '').trim(), 10)
    if (!normalizedDbPath || !Number.isFinite(numericSenderId) || numericSenderId <= 0) {
      return null
    }

    const cacheKey = `${normalizedDbPath}::${numericSenderId}`
    if (this.messageSenderIdCache.has(cacheKey)) {
      return this.messageSenderIdCache.get(cacheKey) || null
    }

    const name2IdTable = await this.resolveMessageName2IdTableName(normalizedDbPath)
    if (!name2IdTable) {
      this.messageSenderIdCache.set(cacheKey, null)
      return null
    }

    const escapedTableName = String(name2IdTable).replace(/"/g, '""')
    const result = await wcdbService.execQuery(
      'message',
      normalizedDbPath,
      `SELECT user_name FROM "${escapedTableName}" WHERE rowid = ${numericSenderId} LIMIT 1`
    )
    const username = result.success && result.rows && result.rows.length > 0
      ? String(result.rows[0]?.user_name || result.rows[0]?.userName || '').trim() || null
      : null
    this.messageSenderIdCache.set(cacheKey, username)
    return username
  }

  async parseMessage(row: any, options?: { source?: 'search' | 'detail'; sessionId?: string }): Promise<Message> {
    void options
    const sourceInfo = getMessageSourceInfo(row)
    const rawContent = decodeMessageContent(
      row.message_content,
      row.compress_content
    )
    const localId = getRowInt(row, ['local_id'], 0)
    const serverIdRaw = normalizeUnsignedIntegerToken(row.server_id)
    const serverId = getRowInt(row, ['server_id'], 0)
    const localType = getRowInt(row, ['local_type'], 0)
    const createTime = getRowTimestampSeconds(row, ['create_time', 'createTime', 'msg_time', 'msgTime', 'time'], 0)
    const sortSeq = getRowInt(row, ['sort_seq'], createTime > 0 ? createTime * 1000 : 0)
    const rawIsSend = row.computed_is_send ?? row.is_send
    const senderUsername = await this.resolveSenderUsernameForMessageRow(row, rawContent)
    const myWxid = this.host.getMyWxidCleaned()
    const sendState = resolveMessageIsSend(rawIsSend === null ? null : parseInt(rawIsSend, 10), senderUsername, myWxid)
    const msg: Message = {
      messageKey: buildMessageKey({
        localId,
        serverId,
        createTime,
        sortSeq,
        senderUsername,
        localType,
        ...sourceInfo
      }),
      localId,
      serverId,
      serverIdRaw,
      localType,
      createTime,
      sortSeq,
      isSend: sendState.isSend,
      senderUsername,
      rawContent,
      content: rawContent,
      parsedContent: parseMessageContent(rawContent, localType),
      _db_path: sourceInfo.dbPath
    }

    if (msg.localId === 0 || msg.createTime === 0) {
      const rawLocalId = row.local_id
      const rawCreateTime = row.create_time
      console.warn('[ChatService] parseMessage raw keys', {
        rawLocalId,
        rawLocalIdType: rawLocalId ? typeof rawLocalId : 'null',
        val_local_id: row['local_id'],
        val_create_time: row['create_time'],
        rawCreateTime,
        rawCreateTimeType: rawCreateTime ? typeof rawCreateTime : 'null'
      })
    }

    if (msg.localType === 3) {
      const imgInfo = parseImageInfo(rawContent)
      msg.imageMd5 = imgInfo.md5
      msg.imageOriginSourceMd5 = imgInfo.originSourceMd5
      msg.aesKey = imgInfo.aesKey
      msg.encrypVer = imgInfo.encrypVer
      msg.cdnThumbUrl = imgInfo.cdnThumbUrl
      msg.imageDatName = parseImageDatNameFromRow(row)
    } else if (msg.localType === 43) {
      msg.videoMd5 = parseVideoFileNameFromRow(row, rawContent)
    } else if (msg.localType === 47) {
      const emojiInfo = parseEmojiInfo(rawContent)
      msg.emojiCdnUrl = emojiInfo.cdnUrl
      msg.emojiMd5 = emojiInfo.md5
      msg.emojiThumbUrl = emojiInfo.thumbUrl
      msg.emojiEncryptUrl = emojiInfo.encryptUrl
      msg.emojiAesKey = emojiInfo.aesKey
    } else if (msg.localType === 42) {
      const cardInfo = parseCardInfo(rawContent)
      msg.cardUsername = cardInfo.username
      msg.cardNickname = cardInfo.nickname
      msg.cardAvatarUrl = cardInfo.avatarUrl
    }

    if (rawContent && (rawContent.includes('<appmsg') || rawContent.includes('&lt;appmsg'))) {
      Object.assign(msg, parseType49Message(rawContent))
    }

    return msg
  }

  private async resolveMessageName2IdTableName(dbPath: string): Promise<string | null> {
    const normalizedDbPath = String(dbPath || '').trim()
    if (!normalizedDbPath) return null
    if (this.messageName2IdTableCache.has(normalizedDbPath)) {
      return this.messageName2IdTableCache.get(normalizedDbPath) || null
    }

    const result = await wcdbService.execQuery(
      'message',
      normalizedDbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%' ORDER BY name DESC LIMIT 1"
    )
    const tableName = result.success && result.rows && result.rows.length > 0
      ? String(result.rows[0]?.name || '').trim() || null
      : null
    this.messageName2IdTableCache.set(normalizedDbPath, tableName)
    return tableName
  }

  private async resolveSenderUsernameForMessageRow(
    row: Record<string, any>,
    rawContent: string
  ): Promise<string | null> {
    const directSender = row.sender_username
      || extractSenderUsernameFromContent(rawContent)
    if (directSender) {
      return directSender
    }

    const dbPath = row._db_path
    const realSenderId = row.real_sender_id
    if (!dbPath || realSenderId === null || realSenderId === undefined || String(realSenderId).trim() === '') {
      return null
    }

    return this.resolveMessageSenderUsernameById(String(dbPath), realSenderId)
  }
}
