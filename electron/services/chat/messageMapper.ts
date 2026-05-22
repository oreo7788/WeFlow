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
  const myWxid = String(myWxidParam || '').trim()

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

      if (senderUsername && !myWxid) {
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
      // Type 49 细分字段
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
      // 名片消息
      let cardUsername: string | undefined
      let cardNickname: string | undefined
      let cardAvatarUrl: string | undefined
      // 转账消息
      let transferPayerUsername: string | undefined
      let transferReceiverUsername: string | undefined
      // 聊天记录
      let chatRecordTitle: string | undefined
      let chatRecordList: Array<{
        datatype: number
        sourcename: string
        sourcetime: string
        sourceheadurl?: string
        datadesc?: string
        datatitle?: string
        fileext?: string
        datasize?: number
        messageuuid?: string
        dataurl?: string
        datathumburl?: string
        datacdnurl?: string
        cdndatakey?: string
        cdnthumbkey?: string
        aeskey?: string
        md5?: string
        fullmd5?: string
        thumbfullmd5?: string
        srcMsgLocalid?: number
        imgheight?: number
        imgwidth?: number
        duration?: number
        chatRecordTitle?: string
        chatRecordDesc?: string
        chatRecordList?: any[]
      }> | undefined

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
        // Type 49 消息（链接、文件、小程序、转账等），8589934592049 也是转账类型
        const type49Info = parseType49Message(content)
        xmlType = type49Info.xmlType
        linkTitle = type49Info.linkTitle
        linkUrl = type49Info.linkUrl
        linkThumb = type49Info.linkThumb
        fileName = type49Info.fileName
        fileSize = type49Info.fileSize
        fileExt = type49Info.fileExt
        fileMd5 = type49Info.fileMd5
        chatRecordTitle = type49Info.chatRecordTitle
        chatRecordList = type49Info.chatRecordList
        transferPayerUsername = type49Info.transferPayerUsername
        transferReceiverUsername = type49Info.transferReceiverUsername
        // 引用消息（appmsg type=57）的 quotedContent/quotedSender
        if (type49Info.quotedContent !== undefined) quotedContent = type49Info.quotedContent
        if (type49Info.quotedSender !== undefined) quotedSender = type49Info.quotedSender
      } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
        const quoteInfo = parseQuoteMessage(content)
        quotedContent = quoteInfo.content
        quotedSender = quoteInfo.sender
      }

      const looksLikeAppMsg = Boolean(content && (content.includes('<appmsg') || content.includes('&lt;appmsg')))
      if (looksLikeAppMsg) {
        const type49Info = parseType49Message(content)
        xmlType = xmlType || type49Info.xmlType
        linkTitle = linkTitle || type49Info.linkTitle
        linkUrl = linkUrl || type49Info.linkUrl
        linkThumb = linkThumb || type49Info.linkThumb
        fileName = fileName || type49Info.fileName
        fileSize = fileSize ?? type49Info.fileSize
        fileExt = fileExt || type49Info.fileExt
        fileMd5 = fileMd5 || type49Info.fileMd5
        appMsgKind = appMsgKind || type49Info.appMsgKind
        appMsgDesc = appMsgDesc || type49Info.appMsgDesc
        appMsgAppName = appMsgAppName || type49Info.appMsgAppName
        appMsgSourceName = appMsgSourceName || type49Info.appMsgSourceName
        appMsgSourceUsername = appMsgSourceUsername || type49Info.appMsgSourceUsername
        appMsgThumbUrl = appMsgThumbUrl || type49Info.appMsgThumbUrl
        appMsgMusicUrl = appMsgMusicUrl || type49Info.appMsgMusicUrl
        appMsgDataUrl = appMsgDataUrl || type49Info.appMsgDataUrl
        appMsgLocationLabel = appMsgLocationLabel || type49Info.appMsgLocationLabel
        finderNickname = finderNickname || type49Info.finderNickname
        finderUsername = finderUsername || type49Info.finderUsername
        finderCoverUrl = finderCoverUrl || type49Info.finderCoverUrl
        finderAvatar = finderAvatar || type49Info.finderAvatar
        finderDuration = finderDuration ?? type49Info.finderDuration
        locationLat = locationLat ?? type49Info.locationLat
        locationLng = locationLng ?? type49Info.locationLng
        locationPoiname = locationPoiname || type49Info.locationPoiname
        locationLabel = locationLabel || type49Info.locationLabel
        musicAlbumUrl = musicAlbumUrl || type49Info.musicAlbumUrl
        musicUrl = musicUrl || type49Info.musicUrl
        giftImageUrl = giftImageUrl || type49Info.giftImageUrl
        giftWish = giftWish || type49Info.giftWish
        giftPrice = giftPrice || type49Info.giftPrice
        chatRecordTitle = chatRecordTitle || type49Info.chatRecordTitle
        chatRecordList = chatRecordList || type49Info.chatRecordList
        transferPayerUsername = transferPayerUsername || type49Info.transferPayerUsername
        transferReceiverUsername = transferReceiverUsername || type49Info.transferReceiverUsername
        if (!quotedContent && type49Info.quotedContent !== undefined) quotedContent = type49Info.quotedContent
        if (!quotedSender && type49Info.quotedSender !== undefined) quotedSender = type49Info.quotedSender
      }

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
        parsedContent: parseMessageContent(content, localType),
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
    return messages
  }