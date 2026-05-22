import * as fzstd from 'fzstd'
import { getRowField } from './messageRowUtils'

const quoteDebugEnabled = () =>
  String(process.env.WEFLOW_CHAT_QUOTE_DEBUG || '').trim() === '1'

function quoteDebugLog(message: string, meta?: unknown): void {
  if (!quoteDebugEnabled()) return
  if (meta !== undefined) console.log(`[DEBUG] ${message}`, meta)
  else console.log(`[DEBUG] ${message}`)
}

export function parseMessageContent(content: string, localType: number): string {
    if (!content) {
      return getMessageTypeLabel(localType)
    }

    // 尝试解码 Buffer
    if (Buffer.isBuffer(content)) {
      content = content.toString('utf-8')
    }

    content = decodeHtmlEntities(content)
    content = cleanUtf16(content)

    // 检查 XML type，用于识别引用消息等
    const xmlType = extractXmlValue(content, 'type')
    const looksLikeAppMsg = content.includes('<appmsg') || content.includes('&lt;appmsg')

    switch (localType) {
      case 1:
        return stripSenderPrefix(content)
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
        return parseType49(content)
      case 50:
        return parseVoipMessage(content)
      case 10000:
        return cleanSystemMessage(content)
      case 244813135921:
        // 引用消息，提取 title
        const title = extractXmlValue(content, 'title')
        return title || '[引用消息]'
      case 266287972401:
        return cleanPatMessage(content)
      case 81604378673:
        return '[聊天记录]'
      case 8594229559345:
        return '[红包]'
      case 8589934592049:
        return '[转账]'
      default:
        // 检查是否是 type=87 的群公告消息
        if (xmlType === '87') {
          const textAnnouncement = extractXmlValue(content, 'textannouncement')
          if (textAnnouncement) {
            return `[群公告] ${textAnnouncement}`
          }
          return '[群公告]'
        }

        // 检查是否是 type=57 的引用消息
        if (xmlType === '57') {
          const title = extractXmlValue(content, 'title')
          return title || '[引用消息]'
        }

        if (looksLikeAppMsg) {
          return parseType49(content)
        }

        // 尝试从 XML 提取通用 title
        const genericTitle = extractXmlValue(content, 'title')
        if (genericTitle && genericTitle.length > 0 && genericTitle.length < 100) {
          return genericTitle
        }

        if (content.length > 200) {
          return getMessageTypeLabel(localType)
        }
        return stripSenderPrefix(content) || getMessageTypeLabel(localType)
    }
  }

export function parseType49(content: string): string {
    const title = extractXmlValue(content, 'title')
    // 从 appmsg 直接子节点提取 type，避免匹配到 refermsg 内部的 <type>
    let type = ''
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
    if (appmsgMatch) {
      const inner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(inner)
      if (typeMatch) type = typeMatch[1].trim()
    }
    if (!type) type = extractXmlValue(content, 'type')
    const normalized = content.toLowerCase()
    const locationLabel =
      extractXmlAttribute(content, 'location', 'label') ||
      extractXmlAttribute(content, 'location', 'poiname') ||
      extractXmlValue(content, 'label') ||
      extractXmlValue(content, 'poiname')
    const isFinder =
      type === '51' ||
      normalized.includes('<finder') ||
      normalized.includes('finderusername') ||
      normalized.includes('finderobjectid')
    const isRedPacket = type === '2001' || normalized.includes('hongbao')
    const isMusic =
      type === '3' ||
      normalized.includes('<musicurl>') ||
      normalized.includes('<playurl>') ||
      normalized.includes('<dataurl>')

    // 群公告消息（type 87）特殊处理
    if (type === '87') {
      const textAnnouncement = extractXmlValue(content, 'textannouncement')
      if (textAnnouncement) {
        return `[群公告] ${textAnnouncement}`
      }
      return '[群公告]'
    }

    if (isFinder) {
      return title ? `[视频号] ${title}` : '[视频号]'
    }
    if (isRedPacket) {
      return title ? `[红包] ${title}` : '[红包]'
    }
    if (locationLabel) {
      return `[位置] ${locationLabel}`
    }
    if (isMusic) {
      return title ? `[音乐] ${title}` : '[音乐]'
    }

    if (title) {
      switch (type) {
        case '5':
        case '49':
          return `[链接] ${title}`
        case '6':
          return `[文件] ${title}`
        case '19':
          return `[聊天记录] ${title}`
        case '33':
        case '36':
          return `[小程序] ${title}`
        case '57':
          // 引用消息，title 就是回复的内容
          return title
        case '53':
          return `[接龙] ${title.split(/\r?\n/).map(line => line.trim()).find(Boolean) || title}`
        case '2000':
          return `[转账] ${title}`
        case '2001':
          return `[红包] ${title}`
        default:
          return title
      }
    }

    // 如果没有 title，根据 type 返回默认标签
    switch (type) {
      case '6':
        return '[文件]'
      case '19':
        return '[聊天记录]'
      case '33':
      case '36':
        return '[小程序]'
      case '2000':
        return '[转账]'
      case '2001':
        return '[红包]'
      case '3':
        return '[音乐]'
      case '5':
      case '49':
        return '[链接]'
      case '87':
        return '[群公告]'
      case '53':
        return '[接龙]'
      default:
        return '[消息]'
    }
  }

  /**
   * 解析表情包信息
   */
export function parseEmojiInfo(content: string): { cdnUrl?: string; md5?: string; thumbUrl?: string; encryptUrl?: string; aesKey?: string } {
    try {
      // 提取 cdnurl
      let cdnUrl: string | undefined
      const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /cdnurl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (cdnUrlMatch) {
        cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try {
            cdnUrl = decodeURIComponent(cdnUrl)
          } catch { }
        }
      }

      // 提取 thumburl
      let thumbUrl: string | undefined
      const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (thumbUrlMatch) {
        thumbUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
        if (thumbUrl.includes('%')) {
          try {
            thumbUrl = decodeURIComponent(thumbUrl)
          } catch { }
        }
      }

      // 提取 md5
      const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) || /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content)
      const md5 = md5Match ? md5Match[1] : undefined

      // 提取 encrypturl
      let encryptUrl: string | undefined
      const encryptUrlMatch = /encrypturl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /encrypturl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (encryptUrlMatch) {
        encryptUrl = encryptUrlMatch[1].replace(/&amp;/g, '&')
        if (encryptUrl.includes('%')) {
          try {
            encryptUrl = decodeURIComponent(encryptUrl)
          } catch { }
        }
      }

      // 提取 aeskey
      const aesKeyMatch = /aeskey\s*=\s*['"]([a-zA-Z0-9]+)['"]/i.exec(content) || /aeskey\s*=\s*([a-zA-Z0-9]+)/i.exec(content)
      const aesKey = aesKeyMatch ? aesKeyMatch[1] : undefined

      return { cdnUrl, md5, thumbUrl, encryptUrl, aesKey }
    } catch (e) {
      console.error('[ChatService] 表情包解析失败:', e, { xml: content })
      return {}
    }
  }

  /**
   * 解析图片信息
   */
export function parseImageInfo(content: string): { md5?: string; originSourceMd5?: string; aesKey?: string; encrypVer?: number; cdnThumbUrl?: string } {
    try {
      const md5 =
        extractXmlValue(content, 'md5') ||
        extractXmlAttribute(content, 'img', 'md5') ||
        undefined
      const originSourceMd5Raw =
        extractXmlAttribute(content, 'img', 'originsourcemd5') ||
        undefined
      const originSourceMd5 = originSourceMd5Raw
        ? originSourceMd5Raw.trim().toLowerCase()
        : undefined
      const aesKey = extractXmlAttribute(content, 'img', 'aeskey') || undefined
      const encrypVerStr = extractXmlAttribute(content, 'img', 'encrypver') || undefined
      const cdnThumbUrl = extractXmlAttribute(content, 'img', 'cdnthumburl') || undefined

      return {
        md5,
        originSourceMd5: originSourceMd5 && originSourceMd5 !== md5?.toLowerCase()
          ? originSourceMd5
          : undefined,
        aesKey,
        encrypVer: encrypVerStr ? parseInt(encrypVerStr, 10) : undefined,
        cdnThumbUrl
      }
    } catch {
      return {}
    }
  }

  /**
   * 解析视频MD5
   * 注意：提取 md5 字段用于查询 hardlink.db，获取实际视频文件名
   */
export function parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      // 优先取 md5 属性（收到的视频）
      const md5 = extractXmlAttribute(content, 'videomsg', 'md5')
      if (md5) return md5.toLowerCase()

      // 自己发的视频没有 md5，只有 rawmd5
      const rawMd5 = extractXmlAttribute(content, 'videomsg', 'rawmd5')
      if (rawMd5) return rawMd5.toLowerCase()

      // 兜底：<md5> 标签
      const tagMd5 = extractXmlValue(content, 'md5')
      if (tagMd5) return tagMd5.toLowerCase()

      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * 解析通话消息
   * 格式: <voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[...]]></msg><room_type>0/1</room_type>...</VoIPBubbleMsg></voipmsg>
   * room_type: 0 = 语音通话, 1 = 视频通话
   * msg 状态: 通话时长 XX:XX, 对方无应答, 已取消, 已在其它设备接听, 对方已拒绝 等
   */
export function parseVoipMessage(content: string): string {
    try {
      if (!content) return '[通话]'

      // 提取 msg 内容（中文通话状态）
      const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content)
      const msg = msgMatch?.[1]?.trim() || ''

      // 提取 room_type（0=视频，1=语音）
      const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content)
      const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1

      // 构建通话类型标签
      let callType: string
      if (roomType === 0) {
        callType = '视频通话'
      } else if (roomType === 1) {
        callType = '语音通话'
      } else {
        callType = '通话'
      }

      // 解析通话状态
      if (msg.includes('通话时长')) {
        // 已接听的通话，提取时长
        const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg)
        const duration = durationMatch?.[1] || ''
        if (duration) {
          return `[${callType}] ${duration}`
        }
        return `[${callType}] 已接听`
      } else if (msg.includes('对方无应答')) {
        return `[${callType}] 对方无应答`
      } else if (msg.includes('已取消')) {
        return `[${callType}] 已取消`
      } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
        return `[${callType}] 已在其他设备接听`
      } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
        return `[${callType}] 对方已拒绝`
      } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
        return `[${callType}] 忙线未接听`
      } else if (msg.includes('未接听')) {
        return `[${callType}] 未接听`
      } else if (msg) {
        // 其他状态直接使用 msg 内容
        return `[${callType}] ${msg}`
      }

      return `[${callType}]`
    } catch (e) {
      console.error('[ChatService] Failed to parse VOIP message:', e)
      return '[通话]'
    }
  }

export function parseImageDatNameFromRow(row: Record<string, any>): string | undefined {
    const packed = getRowField(row, [
      'packed_info_data',
      'packedInfoData',
      'packed_info_blob',
      'packedInfoBlob',
      'packed_info',
      'packedInfo',
      'BytesExtra',
      'bytes_extra',
      'WCDB_CT_packed_info',
      'reserved0',
      'Reserved0',
      'WCDB_CT_Reserved0'
    ])
    const buffer = decodePackedInfo(packed)
    if (!buffer || buffer.length === 0) return undefined
    const printable: number[] = []
    for (const byte of buffer) {
      if (byte >= 0x20 && byte <= 0x7e) {
        printable.push(byte)
      } else {
        printable.push(0x20)
      }
    }
    const text = Buffer.from(printable).toString('utf-8')
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

export function parseVideoFileNameFromRow(row: Record<string, any>, content?: string): string | undefined {
    const packed = getRowField(row, [
      'packed_info_data',
      'packedInfoData',
      'packed_info_blob',
      'packedInfoBlob',
      'packed_info',
      'packedInfo',
      'BytesExtra',
      'bytes_extra',
      'WCDB_CT_packed_info',
      'reserved0',
      'Reserved0',
      'WCDB_CT_Reserved0'
    ])
    const packedToken = extractVideoTokenFromPackedRaw(packed)
    if (packedToken) return packedToken

    const byColumn = normalizeVideoFileToken(getRowField(row, [
      'video_md5',
      'videoMd5',
      'raw_md5',
      'rawMd5',
      'video_file_name',
      'videoFileName'
    ]))
    if (byColumn) return byColumn

    return normalizeVideoFileToken(parseVideoMd5(content || ''))
  }

export function normalizeVideoFileToken(value: unknown): string | undefined {
    let text = String(value || '').trim().toLowerCase()
    if (!text) return undefined
    text = text.replace(/^.*[\\/]/, '')
    text = text.replace(/\.(?:mp4|mov|m4v|avi|mkv|flv|jpg|jpeg|png|gif|dat)$/i, '')
    text = text.replace(/_thumb$/, '')
    const directMatch = /^([a-f0-9]{16,64})(?:_raw)?$/i.exec(text)
    if (directMatch) {
      const suffix = /_raw$/i.test(text) ? '_raw' : ''
      return `${directMatch[1].toLowerCase()}${suffix}`
    }
    const preferred32 = /([a-f0-9]{32})(?![a-f0-9])/i.exec(text)
    if (preferred32?.[1]) return preferred32[1].toLowerCase()
    const generic = /([a-f0-9]{16,64})(?![a-f0-9])/i.exec(text)
    return generic?.[1]?.toLowerCase()
  }

export function extractVideoTokenFromPackedRaw(raw: unknown): string | undefined {
    const buffer = decodePackedInfo(raw)
    if (!buffer || buffer.length === 0) return undefined
    const candidates: string[] = []
    let current = ''
    for (const byte of buffer) {
      const isHex =
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x46) ||
        (byte >= 0x61 && byte <= 0x66)
      if (isHex) {
        current += String.fromCharCode(byte)
        continue
      }
      if (current.length >= 16) candidates.push(current)
      current = ''
    }
    if (current.length >= 16) candidates.push(current)
    if (candidates.length === 0) return undefined

    const exact32 = candidates.find((item) => item.length === 32)
    if (exact32) return exact32.toLowerCase()

    const fallback = candidates.find((item) => item.length >= 16 && item.length <= 64)
    return fallback?.toLowerCase()
  }

export function decodePackedInfo(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      const compactHex = trimmed.replace(/\s+/g, '')
      if (/^[a-fA-F0-9]+$/.test(compactHex) && compactHex.length % 2 === 0) {
        try {
          return Buffer.from(compactHex, 'hex')
        } catch { }
      }
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

export function parseVoiceDurationSeconds(content: string): number | undefined {
    if (!content) return undefined
    const match = /(voicelength|length|time|playlength)\s*=\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/i.exec(content)
    if (!match) return undefined
    const raw = parseFloat(match[2])
    if (!Number.isFinite(raw) || raw <= 0) return undefined
    if (raw > 1000) return Math.round(raw / 1000)
    return Math.round(raw)
  }

  /**
   * 解析引用消息
   */
export function parseQuoteMessage(content: string): { content?: string; sender?: string } {
    try {
      const normalizedContent = decodeHtmlEntities(content || '')
      // 提取 refermsg 部分
      const referMsgStart = normalizedContent.indexOf('<refermsg>')
      const referMsgEnd = normalizedContent.indexOf('</refermsg>')

      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = normalizedContent.substring(referMsgStart, referMsgEnd + 11)

      // 提取发送者名称
      let displayName = extractXmlValue(referMsgXml, 'displayname')
      // 过滤掉 wxid
      if (displayName && looksLikeWxid(displayName)) {
        displayName = ''
      }

      // 提取引用内容
      const referContent = extractXmlValue(referMsgXml, 'content')
      const referType = extractXmlValue(referMsgXml, 'type')

      // 根据类型渲染引用内容
      let displayContent = referContent
      switch (referType) {
        case '1':
          // 文本消息优先取“部分引用”字段，缺失时再回退到完整 content
          displayContent = extractPreferredQuotedText(referMsgXml)
          break
        case '3':
          displayContent = '[图片]'
          break
        case '34':
          displayContent = '[语音]'
          break
        case '43':
          displayContent = '[视频]'
          break
        case '47':
          displayContent = '[动画表情]'
          break
        case '49': {
          // 链接类消息 (type=49)：需区分真正的链接和嵌套引用
          // 嵌套引用的 referContent 中 xmlType=57，真正的链接 xmlType=49 或 5
          const decodedReferContent = decodeHtmlEntities(referContent || '')
          const innerInfo = parseType49Message(decodedReferContent)
          if (innerInfo.xmlType === '57' && innerInfo.linkTitle) {
            displayContent = innerInfo.linkTitle
          } else {
            displayContent = '[链接]'
          }
          break
        }
        case '42':
          displayContent = '[名片]'
          break
        case '48':
          displayContent = '[位置]'
          break
        default:
          if (!referContent || referContent.includes('wxid_')) {
            displayContent = '[消息]'
          } else {
            displayContent = sanitizeQuotedContent(referContent)
          }
      }

      return {
        content: displayContent,
        sender: displayName || undefined
      }
    } catch {
      return {}
    }
  }

  /**
   * 解析媒体消息(图片/视频/语音)中的引用信息
   * 这些消息的引用信息在 <extcommoninfo><refermsg> 中
   */
export function parseMediaQuoteMessage(content: string, sessionId: string): { content?: string; sender?: string } {
    try {
      const normalizedContent = decodeHtmlEntities(content || '')
      const referMsgStart = normalizedContent.indexOf('<refermsg>')
      const referMsgEnd = normalizedContent.indexOf('</refermsg>')

      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = normalizedContent.substring(referMsgStart, referMsgEnd + 11)
      const svrid = extractXmlValue(referMsgXml, 'svrid')

      quoteDebugLog('parseMediaQuoteMessage - svrid:', svrid)

      if (!svrid) {
        return {}
      }

      // 简化方案:返回 svrid 标记
      quoteDebugLog('parseMediaQuoteMessage - 返回标记:', `__SVRID__${svrid}__`)
      return { content: `__SVRID__${svrid}__` }
    } catch {
      return {}
    }
  }
export function extractPreferredQuotedText(referMsgXml: string): string {
    if (!referMsgXml) return ''

    const sources = [decodeHtmlEntities(referMsgXml)]
    const rawMsgSource = extractXmlValue(referMsgXml, 'msgsource')
    if (rawMsgSource) {
      const decodedMsgSource = decodeHtmlEntities(rawMsgSource)
      if (decodedMsgSource) {
        sources.push(decodedMsgSource)
      }
    }

    const fullContent = sanitizeQuotedContent(extractXmlValue(sources[0] || referMsgXml, 'content'))
    const partialText = extractPartialQuotedText(sources[0] || referMsgXml, fullContent)
    if (partialText) return partialText

    const candidateTags = [
      'selectedcontent',
      'selectedtext',
      'selectcontent',
      'selecttext',
      'quotecontent',
      'quotetext',
      'partcontent',
      'parttext',
      'excerpt',
      'summary',
      'preview'
    ]

    for (const source of sources) {
      for (const tag of candidateTags) {
        const value = sanitizeQuotedContent(extractXmlValue(source, tag))
        if (value) return value
      }
    }

    return fullContent
  }

export function extractPartialQuotedText(xml: string, fullContent: string): string {
    if (!xml || !fullContent) return ''

    const startChar = extractXmlValue(xml, 'start')
    const endChar = extractXmlValue(xml, 'end')
    const startIndexRaw = extractXmlValue(xml, 'startindex')
    const endIndexRaw = extractXmlValue(xml, 'endindex')
    const startIndex = Number.parseInt(startIndexRaw, 10)
    const endIndex = Number.parseInt(endIndexRaw, 10)

    if (startChar && endChar) {
      const startPos = fullContent.indexOf(startChar)
      if (startPos !== -1) {
        const endPos = fullContent.indexOf(endChar, startPos + startChar.length - 1)
        if (endPos !== -1 && endPos >= startPos) {
          const sliced = fullContent.slice(startPos, endPos + endChar.length).trim()
          if (sliced) return sliced
        }
      }
    }

    if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && endIndex >= startIndex) {
      const chars = Array.from(fullContent)
      const sliced = chars.slice(startIndex, endIndex + 1).join('').trim()
      if (sliced) return sliced
    }

    return ''
  }

  /**
   * 解析名片消息
   * 格式: <msg username="wxid_xxx" nickname="昵称" ... />
   */
export function parseCardInfo(content: string): { username?: string; nickname?: string; avatarUrl?: string } {
    try {
      if (!content) return {}

      // 提取 username
      const username = extractXmlAttribute(content, 'msg', 'username') || undefined

      // 提取 nickname
      const nickname = extractXmlAttribute(content, 'msg', 'nickname') || undefined

      // 提取头像
      const avatarUrl = extractXmlAttribute(content, 'msg', 'bigheadimgurl') ||
        extractXmlAttribute(content, 'msg', 'smallheadimgurl') || undefined

      return { username, nickname, avatarUrl }
    } catch (e) {
      console.error('[ChatService] 名片解析失败:', e)
      return {}
    }
  }

  /**
   * 解析 Type 49 消息（链接、文件、小程序、转账等）
   * 根据 <appmsg><type>X</type> 区分不同类型
   */
export function parseType49Message(content: string): {
    xmlType?: string
    quotedContent?: string
    quotedSender?: string
    linkTitle?: string
    linkUrl?: string
    linkThumb?: string
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
    cardAvatarUrl?: string
    fileName?: string
    fileSize?: number
    fileExt?: string
    fileMd5?: string
    transferPayerUsername?: string
    transferReceiverUsername?: string
    chatRecordTitle?: string
    chatRecordList?: Array<{
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
    }>
  } {
    try {
      if (!content) return {}

      // 提取 appmsg 直接子节点的 type，避免匹配到 refermsg 内部的 <type>
      // 先尝试从 <appmsg>...</appmsg> 块内提取，再用正则跳过嵌套标签
      let xmlType = ''
      const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
      if (appmsgMatch) {
        // 在 appmsg 内容中，找第一个 <type> 但跳过在子元素内部的（如 refermsg > type）
        // 策略：去掉所有嵌套块（refermsg、patMsg 等），再提取 type
        const appmsgInner = appmsgMatch[1]
          .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
          .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
        const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
        if (typeMatch) xmlType = typeMatch[1].trim()
      }
      if (!xmlType) xmlType = extractXmlValue(content, 'type')
      if (!xmlType) return {}

      const result: any = { xmlType }

      // 提取通用字段
      const title = extractXmlValue(content, 'title')
      const url = extractXmlValue(content, 'url')
      const desc = extractXmlValue(content, 'des') || extractXmlValue(content, 'description')
      const appName = extractXmlValue(content, 'appname')
      const sourceName = extractXmlValue(content, 'sourcename')
      const sourceUsername = extractXmlValue(content, 'sourceusername')
      const thumbUrl =
        extractXmlValue(content, 'thumburl') ||
        extractXmlValue(content, 'cdnthumburl') ||
        extractXmlValue(content, 'cover') ||
        extractXmlValue(content, 'coverurl') ||
        extractXmlValue(content, 'thumb_url')
      const musicUrl =
        extractXmlValue(content, 'musicurl') ||
        extractXmlValue(content, 'playurl') ||
        extractXmlValue(content, 'songalbumurl')
      const dataUrl = extractXmlValue(content, 'dataurl') || extractXmlValue(content, 'lowurl')
      const locationLabel =
        extractXmlAttribute(content, 'location', 'label') ||
        extractXmlAttribute(content, 'location', 'poiname') ||
        extractXmlValue(content, 'label') ||
        extractXmlValue(content, 'poiname')
      const finderUsername =
        extractXmlValue(content, 'finderusername') ||
        extractXmlValue(content, 'finder_username') ||
        extractXmlValue(content, 'finderuser')
      const finderNickname =
        extractXmlValue(content, 'findernickname') ||
        extractXmlValue(content, 'finder_nickname')
      const normalized = content.toLowerCase()
      const isFinder = xmlType === '51'
      const isRedPacket = xmlType === '2001'
      const isMusic = xmlType === '3'
      const isLocation = Boolean(locationLabel)

      result.linkTitle = title || undefined
      result.linkUrl = url || undefined
      result.linkThumb = thumbUrl || undefined
      result.appMsgDesc = desc || undefined
      result.appMsgAppName = appName || undefined
      result.appMsgSourceName = sourceName || undefined
      result.appMsgSourceUsername = sourceUsername || undefined
      result.appMsgThumbUrl = thumbUrl || undefined
      result.appMsgMusicUrl = musicUrl || undefined
      result.appMsgDataUrl = dataUrl || undefined
      result.appMsgLocationLabel = locationLabel || undefined
      result.finderUsername = finderUsername || undefined
      result.finderNickname = finderNickname || undefined

      // 视频号封面/头像/时长
      if (isFinder) {
        const finderCover =
          extractXmlValue(content, 'thumbUrl') ||
          extractXmlValue(content, 'coverUrl') ||
          extractXmlValue(content, 'thumburl') ||
          extractXmlValue(content, 'coverurl')
        if (finderCover) result.finderCoverUrl = finderCover
        const finderAvatar = extractXmlValue(content, 'avatar')
        if (finderAvatar) result.finderAvatar = finderAvatar
        const durationStr = extractXmlValue(content, 'videoPlayDuration') || extractXmlValue(content, 'duration')
        if (durationStr) {
          const d = parseInt(durationStr, 10)
          if (Number.isFinite(d) && d > 0) result.finderDuration = d
        }
      }

      // 位置经纬度
      if (isLocation) {
        const latAttr = extractXmlAttribute(content, 'location', 'x') || extractXmlAttribute(content, 'location', 'latitude')
        const lngAttr = extractXmlAttribute(content, 'location', 'y') || extractXmlAttribute(content, 'location', 'longitude')
        if (latAttr) { const v = parseFloat(latAttr); if (Number.isFinite(v)) result.locationLat = v }
        if (lngAttr) { const v = parseFloat(lngAttr); if (Number.isFinite(v)) result.locationLng = v }
        result.locationPoiname = extractXmlAttribute(content, 'location', 'poiname') || locationLabel || undefined
        result.locationLabel = extractXmlAttribute(content, 'location', 'label') || undefined
      }

      // 音乐专辑封面
      if (isMusic) {
        const albumUrl = extractXmlValue(content, 'songalbumurl')
        if (albumUrl) result.musicAlbumUrl = albumUrl
        result.musicUrl = musicUrl || dataUrl || url || undefined
      }

      // 礼物消息
      const isGift = xmlType === '115'
      if (isGift) {
        result.giftWish = extractXmlValue(content, 'wishmessage') || undefined
        result.giftImageUrl = extractXmlValue(content, 'skuimgurl') || undefined
        result.giftPrice = extractXmlValue(content, 'skuprice') || undefined
      }

      if (isFinder) {
        result.appMsgKind = 'finder'
      } else if (isRedPacket) {
        result.appMsgKind = 'red-packet'
      } else if (isGift) {
        result.appMsgKind = 'gift'
      } else if (isLocation) {
        result.appMsgKind = 'location'
      } else if (isMusic) {
        result.appMsgKind = 'music'
      } else if (xmlType === '33' || xmlType === '36') {
        result.appMsgKind = 'miniapp'
      } else if (xmlType === '6') {
        result.appMsgKind = 'file'
      } else if (xmlType === '19') {
        result.appMsgKind = 'chat-record'
      } else if (xmlType === '2000') {
        result.appMsgKind = 'transfer'
      } else if (xmlType === '87') {
        result.appMsgKind = 'announcement'
      } else if (xmlType === '57') {
        // 引用回复消息，解析 refermsg
        result.appMsgKind = 'quote'
        const quoteInfo = parseQuoteMessage(content)
        result.quotedContent = quoteInfo.content
        result.quotedSender = quoteInfo.sender
      } else if (xmlType === '53') {
        result.appMsgKind = 'solitaire'
      } else if ((xmlType === '5' || xmlType === '49') && (sourceUsername?.startsWith('gh_') || appName?.includes('公众号') || sourceName)) {
        result.appMsgKind = 'official-link'
      } else if (url) {
        result.appMsgKind = 'link'
      } else {
        result.appMsgKind = 'card'
      }

      switch (xmlType) {
        case '6': {
          // 文件消息
          result.fileName = title || extractXmlValue(content, 'filename')
          result.linkTitle = result.fileName

          // 提取文件大小
          const fileSizeStr = extractXmlValue(content, 'totallen') ||
            extractXmlValue(content, 'filesize')
          if (fileSizeStr) {
            const size = parseInt(fileSizeStr, 10)
            if (!isNaN(size)) {
              result.fileSize = size
            }
          }

          // 提取文件扩展名
          const fileExt = extractXmlValue(content, 'fileext')
          const fileMd5 = extractXmlValue(content, 'md5') || extractXmlValue(content, 'filemd5')
          if (fileExt) {
            result.fileExt = fileExt
          } else if (result.fileName) {
            // 从文件名提取扩展名
            const match = /\.([^.]+)$/.exec(result.fileName)
            if (match) {
              result.fileExt = match[1]
            }
          }
          if (fileMd5) {
            result.fileMd5 = fileMd5.toLowerCase()
          }
          break
        }

        case '19': {
          // 聊天记录
          result.chatRecordTitle = title || '聊天记录'
          const recordList = parseForwardChatRecordList(content)
          if (recordList && recordList.length > 0) {
            result.chatRecordList = recordList
          }
          break
        }

        case '33':
        case '36': {
          // 小程序
          result.linkTitle = title
          result.linkUrl = url

          // 提取缩略图
          const thumbUrl = extractXmlValue(content, 'thumburl') ||
            extractXmlValue(content, 'cdnthumburl')
          if (thumbUrl) {
            result.linkThumb = thumbUrl
          }
          break
        }

        case '2000': {
          // 转账
          result.linkTitle = title || '[转账]'

          // 可以提取转账金额等信息
          const payMemo = extractXmlValue(content, 'pay_memo')
          const feedesc = extractXmlValue(content, 'feedesc')

          if (payMemo) {
            result.linkTitle = payMemo
          } else if (feedesc) {
            result.linkTitle = feedesc
          }

          // 提取转账双方 wxid
          const payerUsername = extractXmlValue(content, 'payer_username')
          const receiverUsername = extractXmlValue(content, 'receiver_username')
          if (payerUsername) {
            result.transferPayerUsername = payerUsername
          }
          if (receiverUsername) {
            result.transferReceiverUsername = receiverUsername
          }
          break
        }

        default: {
          // 其他类型，提取通用字段
          result.linkTitle = title
          result.linkUrl = url

          const thumbUrl = extractXmlValue(content, 'thumburl') ||
            extractXmlValue(content, 'cdnthumburl')
          if (thumbUrl) {
            result.linkThumb = thumbUrl
          }
        }
      }

      return result
    } catch (e) {
      console.error('[ChatService] Type 49 消息解析失败:', e)
      return {}
    }
  }

export function parseForwardChatRecordList(content: string): any[] | undefined {
    const normalized = decodeHtmlEntities(content || '')
    if (!normalized.includes('<recorditem') && !normalized.includes('<dataitem')) {
      return undefined
    }

    const items: any[] = []
    const dedupe = new Set<string>()
    const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
    let recordItemMatch: RegExpExecArray | null
    while ((recordItemMatch = recordItemRegex.exec(normalized)) !== null) {
      const parsed = parseForwardChatRecordContainer(recordItemMatch[1] || '')
      for (const item of parsed) {
        const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
        if (!dedupe.has(key)) {
          dedupe.add(key)
          items.push(item)
        }
      }
    }

    if (items.length === 0 && normalized.includes('<dataitem')) {
      const parsed = parseForwardChatRecordContainer(normalized)
      for (const item of parsed) {
        const key = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}|${item.messageuuid || ''}`
        if (!dedupe.has(key)) {
          dedupe.add(key)
          items.push(item)
        }
      }
    }

    return items.length > 0 ? items : undefined
  }

export function extractTopLevelXmlElements(source: string, tagName: string): Array<{ attrs: string; inner: string }> {
    const xml = source || ''
    if (!xml) return []

    const pattern = new RegExp(`<(/?)${tagName}\\b([^>]*)>`, 'gi')
    const result: Array<{ attrs: string; inner: string }> = []
    let match: RegExpExecArray | null
    let depth = 0
    let openEnd = -1
    let openStart = -1
    let openAttrs = ''

    while ((match = pattern.exec(xml)) !== null) {
      const isClosing = match[1] === '/'
      const attrs = match[2] || ''
      const rawTag = match[0] || ''
      const selfClosing = !isClosing && /\/\s*>$/.test(rawTag)

      if (!isClosing) {
        if (depth === 0) {
          openStart = match.index
          openEnd = pattern.lastIndex
          openAttrs = attrs
        }
        if (!selfClosing) {
          depth += 1
        } else if (depth === 0 && openEnd >= 0) {
          result.push({ attrs: openAttrs, inner: '' })
          openStart = -1
          openEnd = -1
          openAttrs = ''
        }
        continue
      }

      if (depth <= 0) continue
      depth -= 1
      if (depth === 0 && openEnd >= 0 && openStart >= 0) {
        result.push({
          attrs: openAttrs,
          inner: xml.slice(openEnd, match.index)
        })
        openStart = -1
        openEnd = -1
        openAttrs = ''
      }
    }

    return result
  }

export function parseForwardChatRecordContainer(containerXml: string): any[] {
    const source = containerXml || ''
    if (!source) return []

    const segments: string[] = [source]
    const decodedContainer = decodeHtmlEntities(source)
    if (decodedContainer !== source) {
      segments.push(decodedContainer)
    }

    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
    let cdataMatch: RegExpExecArray | null
    while ((cdataMatch = cdataRegex.exec(source)) !== null) {
      const cdataInner = cdataMatch[1] || ''
      if (!cdataInner) continue
      segments.push(cdataInner)
      const decodedInner = decodeHtmlEntities(cdataInner)
      if (decodedInner !== cdataInner) {
        segments.push(decodedInner)
      }
    }

    const items: any[] = []
    const seen = new Set<string>()
    for (const segment of segments) {
      if (!segment) continue
      const dataItems = extractTopLevelXmlElements(segment, 'dataitem')
      for (const dataItem of dataItems) {
        const parsed = parseForwardChatRecordDataItem(dataItem.inner || '', dataItem.attrs || '')
        if (!parsed) continue
        const key = `${parsed.datatype}|${parsed.sourcename}|${parsed.sourcetime}|${parsed.datadesc || ''}|${parsed.datatitle || ''}|${parsed.messageuuid || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          items.push(parsed)
        }
      }
    }

    if (items.length > 0) return items
    const fallback = parseForwardChatRecordDataItem(source, '')
    return fallback ? [fallback] : []
  }

export function parseForwardChatRecordDataItem(itemXml: string, attrs: string): any | null {
    const datatypeMatch = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
    const datatype = datatypeMatch ? parseInt(datatypeMatch[1], 10) : parseInt(extractXmlValue(itemXml, 'datatype') || '0', 10)
    const sourcename = decodeHtmlEntities(extractXmlValue(itemXml, 'sourcename') || '')
    const sourcetime = extractXmlValue(itemXml, 'sourcetime') || ''
    const sourceheadurl = extractXmlValue(itemXml, 'sourceheadurl') || undefined
    const datadesc = decodeHtmlEntities(
      extractXmlValue(itemXml, 'datadesc') ||
      extractXmlValue(itemXml, 'content') ||
      ''
    ) || undefined
    const datatitle = decodeHtmlEntities(extractXmlValue(itemXml, 'datatitle') || '') || undefined
    const fileext = extractXmlValue(itemXml, 'fileext') || undefined
    const datasize = parseInt(extractXmlValue(itemXml, 'datasize') || '0', 10) || undefined
    const messageuuid = extractXmlValue(itemXml, 'messageuuid') || undefined
    const dataurl = decodeHtmlEntities(extractXmlValue(itemXml, 'dataurl') || '') || undefined
    const datathumburl = decodeHtmlEntities(
      extractXmlValue(itemXml, 'datathumburl') ||
      extractXmlValue(itemXml, 'thumburl') ||
      extractXmlValue(itemXml, 'cdnthumburl') ||
      ''
    ) || undefined
    const datacdnurl = decodeHtmlEntities(
      extractXmlValue(itemXml, 'datacdnurl') ||
      extractXmlValue(itemXml, 'cdnurl') ||
      extractXmlValue(itemXml, 'cdndataurl') ||
      ''
    ) || undefined
    const cdndatakey = extractXmlValue(itemXml, 'cdndatakey') || undefined
    const cdnthumbkey = extractXmlValue(itemXml, 'cdnthumbkey') || undefined
    const aeskey = decodeHtmlEntities(
      extractXmlValue(itemXml, 'aeskey') ||
      extractXmlValue(itemXml, 'qaeskey') ||
      ''
    ) || undefined
    const md5 = extractXmlValue(itemXml, 'md5') || extractXmlValue(itemXml, 'datamd5') || undefined
    const fullmd5 = extractXmlValue(itemXml, 'fullmd5') || undefined
    const thumbfullmd5 = extractXmlValue(itemXml, 'thumbfullmd5') || undefined
    const srcMsgLocalid = parseInt(extractXmlValue(itemXml, 'srcMsgLocalid') || '0', 10) || undefined
    const imgheight = parseInt(extractXmlValue(itemXml, 'imgheight') || '0', 10) || undefined
    const imgwidth = parseInt(extractXmlValue(itemXml, 'imgwidth') || '0', 10) || undefined
    const duration = parseInt(extractXmlValue(itemXml, 'duration') || '0', 10) || undefined
    const nestedRecordXml = extractXmlValue(itemXml, 'recordxml') || undefined
    const chatRecordTitle = decodeHtmlEntities(
      (nestedRecordXml && extractXmlValue(nestedRecordXml, 'title')) ||
      datatitle ||
      ''
    ) || undefined
    const chatRecordDesc = decodeHtmlEntities(
      (nestedRecordXml && extractXmlValue(nestedRecordXml, 'desc')) ||
      datadesc ||
      ''
    ) || undefined
    const chatRecordList =
      datatype === 17 && nestedRecordXml
        ? parseForwardChatRecordContainer(nestedRecordXml)
        : undefined

    if (!(datatype || sourcename || datadesc || datatitle || messageuuid || srcMsgLocalid)) return null

    return {
      datatype: Number.isFinite(datatype) ? datatype : 0,
      sourcename,
      sourcetime,
      sourceheadurl,
      datadesc,
      datatitle,
      fileext,
      datasize,
      messageuuid,
      dataurl,
      datathumburl,
      datacdnurl,
      cdndatakey,
      cdnthumbkey,
      aeskey,
      md5,
      fullmd5,
      thumbfullmd5,
      srcMsgLocalid,
      imgheight,
      imgwidth,
      duration,
      chatRecordTitle,
      chatRecordDesc,
      chatRecordList
    }
  }
export function looksLikeWxid(text: string): boolean {
    if (!text) return false
    const trimmed = text.trim().toLowerCase()
    if (trimmed.startsWith('wxid_')) return true
    return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
  }

  /**
   * 清理引用内容中的 wxid
   */
export function sanitizeQuotedContent(content: string): string {
    if (!content) return ''
    let result = content
    // 去掉 wxid_xxx
    result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
    // 去掉开头的分隔符
    result = result.replace(/^[\s:：\-]+/, '')
    // 折叠重复分隔符
    result = result.replace(/[:：]{2,}/g, ':')
    result = result.replace(/^[\s:：\-]+/, '')
    // 标准化空白
    result = result.replace(/\s+/g, ' ').trim()
    return result
  }

export function getMessageTypeLabel(localType: number): string {
    const labels: Record<number, string> = {
      1: '[文本]',
      3: '[图片]',
      34: '[语音]',
      42: '[名片]',
      43: '[视频]',
      47: '[动画表情]',
      48: '[位置]',
      49: '[链接]',
      50: '[通话]',
      10000: '[系统消息]',
      244813135921: '[引用消息]',
      266287972401: '拍一拍',
      81604378673: '[聊天记录]',
      154618822705: '[小程序]',
      8594229559345: '[红包]',
      8589934592049: '[转账]',
      34359738417: '[文件]',
      103079215153: '[文件]',
      25769803825: '[文件]'
    }
    return labels[localType] || '[消息]'
  }

export function extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

export function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
    // 匹配 <tagName ... attrName="value" ... /> 或 <tagName ... attrName="value" ...>
    const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"']`, 'i')
    const match = regex.exec(xml)
    return match ? match[1] : ''
  }

export function cleanSystemMessage(content: string): string {
    if (!content) return '[系统消息]'

    const normalized = cleanUtf16(decodeHtmlEntities(String(content)))
    const readableSysmsg = extractReadableSystemMessageText(normalized)
    if (readableSysmsg) {
      return readableSysmsg
    }

    // 移除 XML 声明
    let cleaned = normalized.replace(/<\?xml[^?]*\?>/gi, '')
    // 移除所有 XML/HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 移除尾部的数字（如撤回消息后的时间戳）
    cleaned = cleaned.replace(/\d+\s*$/, '')
    // 清理多余空白
    cleaned = stripSenderPrefix(cleaned).replace(/\s+/g, ' ').trim()
    return cleaned || '[系统消息]'
  }

export function extractReadableSystemMessageText(content: string): string {
    const sysmsgMatch = /<sysmsg\b[^>]*>([\s\S]*?)<\/sysmsg>/i.exec(content)
    const source = sysmsgMatch?.[1] || content
    const text =
      extractXmlValue(source, 'plain') ||
      extractXmlValue(source, 'text') ||
      ''
    return stripSenderPrefix(text).replace(/\s+/g, ' ').trim()
  }

export function stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_@-]+):(?!\/\/)(?:\s*(?:\r?\n|<br\s*\/?>)\s*|\s*)/i, '')
  }

export function extractSenderUsernameFromContent(content: string): string | null {
    if (!content) return null

    const normalized = cleanUtf16(decodeHtmlEntities(String(content)))
    const match = /^\s*([a-zA-Z0-9_@-]{4,}):(?!\/\/)\s*(?:\r?\n|<br\s*\/?>)/i.exec(normalized)
    if (!match?.[1]) return null

    const candidate = match[1].trim()
    return candidate || null
  }

export function decodeHtmlEntities(content: string): string {
    return content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  }

export function cleanString(str: string): string {
    if (!str) return ''
    if (Buffer.isBuffer(str)) {
      str = str.toString('utf-8')
    }
    return cleanUtf16(String(str))
  }

export function cleanUtf16(input: string): string {
    if (!input) return input
    try {
      const cleaned = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      const codeUnits = cleaned.split('').map((c) => c.charCodeAt(0))
      const validUnits: number[] = []
      for (let i = 0; i < codeUnits.length; i += 1) {
        const unit = codeUnits[i]
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (i + 1 < codeUnits.length) {
            const nextUnit = codeUnits[i + 1]
            if (nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
              validUnits.push(unit, nextUnit)
              i += 1
              continue
            }
          }
          continue
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          continue
        }
        validUnits.push(unit)
      }
      return String.fromCharCode(...validUnits)
    } catch {
      return input.replace(/[^\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F]/g, '')
    }
  }

  /**
   * 清理拍一拍消息
   * 格式示例:
   *   纯文本: 我拍了拍 "XX" 
   *   XML: <msg><appmsg...><title>"XX"拍了拍"XX"相信未来!</title>...</msg>
   */
export function cleanPatMessage(content: string): string {
    if (!content) return '拍一拍'

    // 1. 优先从 XML <title> 标签提取内容
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(content)
    if (titleMatch) {
      const title = titleMatch[1]
        .replace(/<!\[CDATA\[/g, '')
        .replace(/\]\]>/g, '')
        .trim()
      if (title) {
        return title
      }
    }

    // 2. 尝试匹配标准的 "A拍了拍B" 格式
    const match = /^(.+?拍了拍.+?)(?:[\r\n]|$|ງ|wxid_)/.exec(content)
    if (match) {
      return match[1].trim()
    }

    // 3. 如果匹配失败，尝试清理掉疑似的 garbage (wxid, 乱码)
    let cleaned = content.replace(/wxid_[a-zA-Z0-9_-]+/g, '') // 移除 wxid
    cleaned = cleaned.replace(/[ງ໐໓ຖiht]+/g, ' ') // 移除已知的乱码字符
    cleaned = cleaned.replace(/\d{6,}/g, '') // 移除长数字
    cleaned = cleaned.replace(/\s+/g, ' ').trim() // 清理空格

    // 移除不可见字符
    cleaned = cleanUtf16(cleaned)

    // 如果清理后还有内容，返回
    if (cleaned && cleaned.length > 1 && !cleaned.includes('xml')) {
      return cleaned
    }

    return '拍一拍'
  }

  /**
   * 解码消息内容（处理 BLOB 和压缩数据）
   */
export function decodeMessageContent(messageContent: any, compressContent: any): string {
    // 优先使用 compress_content
    let content = decodeMaybeCompressed(compressContent, 'compress_content')
    if (!content || content.length === 0) {
      content = decodeMaybeCompressed(messageContent, 'message_content')
    }
    return content
  }

  /**
   * 尝试解码可能压缩的内容
   */
export function decodeMaybeCompressed(raw: any, fieldName: string = 'unknown'): string {
    if (!raw) return ''

    // 

    // 如果是 Buffer/Uint8Array
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      return decodeBinaryContent(Buffer.from(raw), String(raw))
    }

    // 如果是字符串
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      const compactRaw = compactEncodedPayload(raw)

      // 检查是否是 hex 编码
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (compactRaw.length > 16 && looksLikeHex(compactRaw)) {
        const bytes = Buffer.from(compactRaw, 'hex')
        if (bytes.length > 0) {
          const result = decodeBinaryContent(bytes, raw)
          // 
          return result
        }
      }

      // 检查是否是 base64 编码
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (compactRaw.length > 16 && looksLikeBase64(compactRaw)) {
        try {
          const bytes = Buffer.from(compactRaw, 'base64')
          return decodeBinaryContent(bytes, raw)
        } catch { }
      }

      // 普通字符串
      return raw
    }

    return ''
  }

  /**
   * 解码二进制内容（处理 zstd 压缩）
   */
export function decodeBinaryContent(data: Buffer, fallbackValue?: string): string {
    if (data.length === 0) return ''

    try {
      // 检查是否是 zstd 压缩数据 (magic number: 0xFD2FB528)
      if (data.length >= 4) {
        const magicLE = data.readUInt32LE(0)
        const magicBE = data.readUInt32BE(0)
        if (magicLE === 0xFD2FB528 || magicBE === 0xFD2FB528) {
          // zstd 压缩，需要解压
          try {
            const decompressed = fzstd.decompress(data)
            return Buffer.from(decompressed).toString('utf-8')
          } catch (e) {
            console.error('zstd 解压失败:', e)
          }
        }
      }

      // 尝试直接 UTF-8 解码
      const decoded = data.toString('utf-8')
      // 检查是否有太多替换字符
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }

      // 如果提供了 fallbackValue，且解码结果看起来像二进制垃圾，则返回 fallbackValue
      if (fallbackValue && replacementCount > 0) {
        // 
        return fallbackValue
      }

      // 尝试 latin1 解码
      return data.toString('latin1')
    } catch {
      return fallbackValue || ''
    }
  }

  /**
   * 检查是否像 hex 编码
   */
export function looksLikeHex(s: string): boolean {
    const compact = compactEncodedPayload(s)
    if (compact.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(compact)
  }

  /**
   * 检查是否像 base64 编码
   */
export function looksLikeBase64(s: string): boolean {
    const compact = compactEncodedPayload(s)
    if (compact.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(compact)
  }

export function compactEncodedPayload(raw: string): string {
    return String(raw || '').replace(/\s+/g, '').trim()
  }

/** 导出统计用：从 Type49 XML 提取 appmsg type */
export function extractType49XmlTypeForStats(content: string): string {
  if (!content) return ''

  const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
  if (appmsgMatch) {
    const appmsgInner = appmsgMatch[1]
      .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
      .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
    const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
    if (typeMatch) return String(typeMatch[1] || '').trim()
  }

  return extractXmlValue(content, 'type')
}