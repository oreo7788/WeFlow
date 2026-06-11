import type { Message } from './types'
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
  extractXmlAttribute,
  extractXmlValue,
  parseCardInfo,
  parseEmojiInfo,
  parseImageDatNameFromRow,
  parseImageInfo,
  parseMediaQuoteMessage,
  parseMessageContent,
  parseQuoteMessage,
  parseType49Message,
  parseVideoFileNameFromRow,
  parseVoiceDurationSeconds
} from './messageParsing'

type MapRowsOptions = {
  forList?: boolean
}

type Type49FieldBag = {
  xmlType?: string
  linkTitle?: string
  linkUrl?: string
  linkThumb?: string
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
  appMsgKind?: string
  appMsgDesc?: string
  appMsgAppName?: string
  appMsgSourceName?: string
  appMsgSourceUsername?: string
  appMsgThumbUrl?: string
  appMsgMusicUrl?: string
  appMsgDataUrl?: string
  appMsgLocationLabel?: string
  finderNickname?: string
  finderUsername?: string
  finderCoverUrl?: string
  finderAvatar?: string
  finderDuration?: number
  locationLat?: number
  locationLng?: number
  locationPoiname?: string
  locationLabel?: string
  musicAlbumUrl?: string
  musicUrl?: string
  giftImageUrl?: string
  giftWish?: string
  giftPrice?: string
  chatRecordTitle?: string
  chatRecordList?: Message['chatRecordList']
  transferPayerUsername?: string
  transferReceiverUsername?: string
  quotedContent?: string
  quotedSender?: string
}

function mergeType49Info(target: Type49FieldBag, source: ReturnType<typeof parseType49Message>, mode: 'replace' | 'merge'): void {
  const assign = <K extends keyof Type49FieldBag>(key: K, value: Type49FieldBag[K]) => {
    if (value === undefined || value === null) return
    if (mode === 'replace' || target[key] === undefined || target[key] === null) {
      target[key] = value
      return
    }
    if (typeof value === 'number' && typeof target[key] === 'number') {
      target[key] = value
    }
  }

  assign('xmlType', source.xmlType)
  assign('linkTitle', source.linkTitle)
  assign('linkUrl', source.linkUrl)
  assign('linkThumb', source.linkThumb)
  assign('fileName', source.fileName)
  assign('fileSize', source.fileSize)
  assign('fileExt', source.fileExt)
  assign('fileMd5', source.fileMd5)
  assign('appMsgKind', source.appMsgKind)
  assign('appMsgDesc', source.appMsgDesc)
  assign('appMsgAppName', source.appMsgAppName)
  assign('appMsgSourceName', source.appMsgSourceName)
  assign('appMsgSourceUsername', source.appMsgSourceUsername)
  assign('appMsgThumbUrl', source.appMsgThumbUrl)
  assign('appMsgMusicUrl', source.appMsgMusicUrl)
  assign('appMsgDataUrl', source.appMsgDataUrl)
  assign('appMsgLocationLabel', source.appMsgLocationLabel)
  assign('finderNickname', source.finderNickname)
  assign('finderUsername', source.finderUsername)
  assign('finderCoverUrl', source.finderCoverUrl)
  assign('finderAvatar', source.finderAvatar)
  assign('finderDuration', source.finderDuration)
  assign('locationLat', source.locationLat)
  assign('locationLng', source.locationLng)
  assign('locationPoiname', source.locationPoiname)
  assign('locationLabel', source.locationLabel)
  assign('musicAlbumUrl', source.musicAlbumUrl)
  assign('musicUrl', source.musicUrl)
  assign('giftImageUrl', source.giftImageUrl)
  assign('giftWish', source.giftWish)
  assign('giftPrice', source.giftPrice)
  assign('chatRecordTitle', source.chatRecordTitle)
  assign('chatRecordList', source.chatRecordList)
  assign('transferPayerUsername', source.transferPayerUsername)
  assign('transferReceiverUsername', source.transferReceiverUsername)
  if (source.quotedContent !== undefined) {
    assign('quotedContent', source.quotedContent)
  }
  if (source.quotedSender !== undefined) {
    assign('quotedSender', source.quotedSender)
  }
}

function resolveListParsedContent(content: string, localType: number): string {
  switch (localType) {
    case 3:
      return '[图片]'
    case 34:
      return '[语音消息]'
    case 42:
      return '[名片]'
    case 43:
      return '[视频]'
    case 47:
      return '[动画表情]'
    case 48: {
      const label =
        extractXmlAttribute(content, 'location', 'label') ||
        extractXmlAttribute(content, 'location', 'poiname') ||
        extractXmlValue(content, 'label') ||
        extractXmlValue(content, 'poiname')
      return label ? `[位置] ${label}` : '[位置]'
    }
    case 49:
    case 8589934592049:
    case 244813135921:
    case 81604378673:
    case 8594229559345:
      return parseMessageContent(content, localType)
    default:
      return parseMessageContent(content, localType)
  }
}

export function enrichMessageForDisplay(message: Message, sessionId: string, row?: Record<string, any>): Message {
  if (!row) return message
  const [enriched] = mapRowsToMessagesInternal([row], sessionId, '', { forList: false })
  if (!enriched) return message
  return {
    ...message,
    ...enriched,
    messageKey: message.messageKey || enriched.messageKey,
    parsedContent: enriched.parsedContent || message.parsedContent,
    rawContent: message.rawContent || enriched.rawContent,
    content: message.content || enriched.content
  }
}

export function mapRowsToMessagesForList(rows: Record<string, any>[], sessionId: string, myWxidParam: string): Message[] {
  return mapRowsToMessagesInternal(rows, sessionId, myWxidParam, { forList: true })
}

export function mapRowsToMessagesLite(rows: Record<string, any>[], myWxidParam: string): Message[] {
    const myWxid = String(myWxidParam || '').trim()
    const messages: Message[] = []
    for (const row of rows) {
      const sourceInfo = getMessageSourceInfo(row)
      const localType = getRowInt(row, ['local_type'], 1)
      const createTime = getRowTimestampSeconds(row, ['create_time', 'createTime', 'msg_time', 'msgTime', 'time'], 0)
      const sortSeq = getRowInt(row, ['sort_seq'], createTime > 0 ? createTime * 1000 : 0)
      const localId = getRowInt(row, ['local_id'], 0)
      const serverIdRaw = normalizeUnsignedIntegerToken(row.server_id)
      const serverId = getRowInt(row, ['server_id'], 0)
      const content = decodeMessageContent(row.message_content, row.compress_content)

      const isSendRaw = row.computed_is_send ?? row.is_send
      const parsedRawIsSend = isSendRaw === null || isSendRaw === undefined
        ? null
        : parseInt(String(isSendRaw), 10)
      const normalizedIsSend = typeof parsedRawIsSend === 'number' && Number.isFinite(parsedRawIsSend)
        ? parsedRawIsSend
        : null
      const senderFromRow = String(row.sender_username || '').trim() || extractSenderUsernameFromContent(content) || null
      const { isSend } = resolveMessageIsSend(normalizedIsSend, senderFromRow, myWxid)
      const senderUsername = senderFromRow || (isSend === 1 && myWxid ? myWxid : null)

      messages.push({
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
        isSend,
        senderUsername,
        parsedContent: '',
        rawContent: content,
        content,
        _db_path: sourceInfo.dbPath
      })
    }
    return messages
  }

export function mapRowsToMessages(rows: Record<string, any>[], sessionId: string, myWxidParam: string): Message[] {
  return mapRowsToMessagesInternal(rows, sessionId, myWxidParam, { forList: false })
}

function mapRowsToMessagesInternal(
  rows: Record<string, any>[],
  sessionId: string,
  myWxidParam: string,
  options: MapRowsOptions = {}
): Message[] {
  const myWxid = String(myWxidParam || '').trim()
  const forList = options.forList === true

    const messages: Message[] = []
    for (const row of rows) {
      const sourceInfo = getMessageSourceInfo(row)
      const rawMessageContent = row.message_content
      const rawCompressContent = row.compress_content

      const content = decodeMessageContent(rawMessageContent, rawCompressContent);
      const localType = getRowInt(row, ['local_type'], 1)
      const isSendRaw = row.computed_is_send ?? row.is_send
      const parsedRawIsSend = isSendRaw === null ? null : parseInt(isSendRaw, 10)
      const senderUsername = row.sender_username
        || extractSenderUsernameFromContent(content)
        || null
      const { isSend } = resolveMessageIsSend(parsedRawIsSend, senderUsername, myWxid)
      const createTime = getRowTimestampSeconds(row, ['create_time', 'createTime', 'msg_time', 'msgTime', 'time'], 0)

      if (!forList && senderUsername && !myWxid) {
        // [DEBUG] Issue #34: 未配置 myWxid，无法判断是否发送
        if (messages.length < 5) {
          console.warn(`[ChatService] Warning: myWxid not set. Cannot determine if message is sent by me. sender=${senderUsername}`)
        }
      }

      let emojiCdnUrl: string | undefined
      let emojiMd5: string | undefined
      let quotedContent: string | undefined
      let quotedSender: string | undefined
      let imageMd5: string | undefined
      let imageOriginSourceMd5: string | undefined
      let imageDatName: string | undefined
      let videoMd5: string | undefined
      let aesKey: string | undefined
      let encrypVer: number | undefined
      let cdnThumbUrl: string | undefined
      let voiceDurationSeconds: number | undefined
      let linkTitle: string | undefined
      let linkUrl: string | undefined
      let linkThumb: string | undefined
      let fileName: string | undefined
      let fileSize: number | undefined
      let fileExt: string | undefined
      let fileMd5: string | undefined
      let xmlType: string | undefined
      let appMsgKind: string | undefined
      let appMsgDesc: string | undefined
      let appMsgAppName: string | undefined
      let appMsgSourceName: string | undefined
      let appMsgSourceUsername: string | undefined
      let appMsgThumbUrl: string | undefined
      let appMsgMusicUrl: string | undefined
      let appMsgDataUrl: string | undefined
      let appMsgLocationLabel: string | undefined
      let finderNickname: string | undefined
      let finderUsername: string | undefined
      let finderCoverUrl: string | undefined
      let finderAvatar: string | undefined
      let finderDuration: number | undefined
      let locationLat: number | undefined
      let locationLng: number | undefined
      let locationPoiname: string | undefined
      let locationLabel: string | undefined
      let musicAlbumUrl: string | undefined
      let musicUrl: string | undefined
      let giftImageUrl: string | undefined
      let giftWish: string | undefined
      let giftPrice: string | undefined
      let cardUsername: string | undefined
      let cardNickname: string | undefined
      let cardAvatarUrl: string | undefined
      let transferPayerUsername: string | undefined
      let transferReceiverUsername: string | undefined
      let chatRecordTitle: string | undefined
      let chatRecordList: Message['chatRecordList']
      const type49Fields: Type49FieldBag = {}
      let type49Parsed = false

      if (localType === 47 && content) {
        const emojiInfo = parseEmojiInfo(content)
        emojiCdnUrl = emojiInfo.cdnUrl
        emojiMd5 = emojiInfo.md5
        cdnThumbUrl = emojiInfo.thumbUrl // 复用 cdnThumbUrl 字段或使用 emojiThumbUrl
        // 注意：Message 接口定义的 emojiThumbUrl，这里我们统一一下
        // 如果 Message 接口有 emojiThumbUrl，则使用它
      } else if (localType === 3 && content) {
        const imageInfo = parseImageInfo(content)
        imageMd5 = imageInfo.md5
        imageOriginSourceMd5 = imageInfo.originSourceMd5
        aesKey = imageInfo.aesKey
        encrypVer = imageInfo.encrypVer
        cdnThumbUrl = imageInfo.cdnThumbUrl
        imageDatName = parseImageDatNameFromRow(row)
        // 解析图片消息中的引用信息
        const quoteInfo = parseMediaQuoteMessage(content, sessionId)
        if (quoteInfo.content) quotedContent = quoteInfo.content
        if (quoteInfo.sender) quotedSender = quoteInfo.sender
      } else if (localType === 43) {
        // 视频消息：优先从 packed_info_data 提取真实文件名（32位十六进制），再回退 XML
        videoMd5 = parseVideoFileNameFromRow(row, content)
        // 解析视频消息中的引用信息
        const quoteInfo = parseMediaQuoteMessage(content, sessionId)
        if (quoteInfo.content) quotedContent = quoteInfo.content
        if (quoteInfo.sender) quotedSender = quoteInfo.sender
      } else if (localType === 34 && content) {
        voiceDurationSeconds = parseVoiceDurationSeconds(content)
        // 解析语音消息中的引用信息
        const quoteInfo = parseMediaQuoteMessage(content, sessionId)
        if (quoteInfo.content) quotedContent = quoteInfo.content
        if (quoteInfo.sender) quotedSender = quoteInfo.sender
      } else if (localType === 42 && content) {
        // 名片消息
        const cardInfo = parseCardInfo(content)
        cardUsername = cardInfo.username
        cardNickname = cardInfo.nickname
        cardAvatarUrl = cardInfo.avatarUrl
      } else if (localType === 48 && content) {
        // 位置消息
        const latStr = extractXmlAttribute(content, 'location', 'x') || extractXmlAttribute(content, 'location', 'latitude')
        const lngStr = extractXmlAttribute(content, 'location', 'y') || extractXmlAttribute(content, 'location', 'longitude')
        if (latStr) { const v = parseFloat(latStr); if (Number.isFinite(v)) locationLat = v }
        if (lngStr) { const v = parseFloat(lngStr); if (Number.isFinite(v)) locationLng = v }
        locationLabel = extractXmlAttribute(content, 'location', 'label') || extractXmlValue(content, 'label') || undefined
        locationPoiname = extractXmlAttribute(content, 'location', 'poiname') || extractXmlValue(content, 'poiname') || undefined
      } else if ((localType === 49 || localType === 8589934592049) && content) {
        mergeType49Info(type49Fields, parseType49Message(content), 'replace')
        type49Parsed = true
      } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
        const quoteInfo = parseQuoteMessage(content)
        quotedContent = quoteInfo.content
        quotedSender = quoteInfo.sender
      }

      const looksLikeAppMsg = Boolean(content && (content.includes('<appmsg') || content.includes('&lt;appmsg')))
      if (!type49Parsed && looksLikeAppMsg) {
        mergeType49Info(type49Fields, parseType49Message(content), 'merge')
        type49Parsed = true
      }

      xmlType = type49Fields.xmlType
      linkTitle = type49Fields.linkTitle
      linkUrl = type49Fields.linkUrl
      linkThumb = type49Fields.linkThumb
      fileName = type49Fields.fileName
      fileSize = type49Fields.fileSize
      fileExt = type49Fields.fileExt
      fileMd5 = type49Fields.fileMd5
      appMsgKind = type49Fields.appMsgKind
      appMsgDesc = type49Fields.appMsgDesc
      appMsgAppName = type49Fields.appMsgAppName
      appMsgSourceName = type49Fields.appMsgSourceName
      appMsgSourceUsername = type49Fields.appMsgSourceUsername
      appMsgThumbUrl = type49Fields.appMsgThumbUrl
      appMsgMusicUrl = type49Fields.appMsgMusicUrl
      appMsgDataUrl = type49Fields.appMsgDataUrl
      appMsgLocationLabel = type49Fields.appMsgLocationLabel
      finderNickname = type49Fields.finderNickname
      finderUsername = type49Fields.finderUsername
      finderCoverUrl = type49Fields.finderCoverUrl
      finderAvatar = type49Fields.finderAvatar
      finderDuration = type49Fields.finderDuration
      locationLat = type49Fields.locationLat
      locationLng = type49Fields.locationLng
      locationPoiname = type49Fields.locationPoiname
      locationLabel = type49Fields.locationLabel
      musicAlbumUrl = type49Fields.musicAlbumUrl
      musicUrl = type49Fields.musicUrl
      giftImageUrl = type49Fields.giftImageUrl
      giftWish = type49Fields.giftWish
      giftPrice = type49Fields.giftPrice
      chatRecordTitle = type49Fields.chatRecordTitle
      chatRecordList = type49Fields.chatRecordList
      transferPayerUsername = type49Fields.transferPayerUsername
      transferReceiverUsername = type49Fields.transferReceiverUsername
      if (type49Fields.quotedContent !== undefined) quotedContent = type49Fields.quotedContent
      if (type49Fields.quotedSender !== undefined) quotedSender = type49Fields.quotedSender

      const localId = getRowInt(row, ['local_id'], 0)
      const serverIdRaw = normalizeUnsignedIntegerToken(row.server_id)
      const serverId = getRowInt(row, ['server_id'], 0)
      const sortSeq = getRowInt(row, ['sort_seq'], createTime)

      messages.push({
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
        isSend,
        senderUsername,
        parsedContent: forList
          ? resolveListParsedContent(content, localType)
          : parseMessageContent(content, localType),
        rawContent: content,
        emojiCdnUrl,
        emojiMd5,
        quotedContent,
        quotedSender,
        imageMd5,
        imageOriginSourceMd5,
        imageDatName,
        videoMd5,
        voiceDurationSeconds,
        aesKey,
        encrypVer,
        cdnThumbUrl,
        linkTitle,
        linkUrl,
        linkThumb,
        fileName,
        fileSize,
        fileExt,
        fileMd5,
        xmlType,
        appMsgKind,
        appMsgDesc,
        appMsgAppName,
        appMsgSourceName,
        appMsgSourceUsername,
        appMsgThumbUrl,
        appMsgMusicUrl,
        appMsgDataUrl,
        appMsgLocationLabel,
        finderNickname,
        finderUsername,
        finderCoverUrl,
        finderAvatar,
        finderDuration,
        locationLat,
        locationLng,
        locationPoiname,
        locationLabel,
        musicAlbumUrl,
        musicUrl,
        giftImageUrl,
        giftWish,
        giftPrice,
        cardUsername,
        cardNickname,
        cardAvatarUrl,
        transferPayerUsername,
        transferReceiverUsername,
        chatRecordTitle,
        chatRecordList,
        _db_path: sourceInfo.dbPath
      })
      if (!forList) {
        const last = messages[messages.length - 1]
        if ((last.localType === 3 || last.localType === 34) && (last.localId === 0 || last.createTime === 0)) {
          console.warn('[ChatService] message key missing', {
            localType: last.localType,
            localId: last.localId,
            createTime: last.createTime,
            rowKeys: Object.keys(row)
          })
        }
      }
    }
    return messages
  }