import type { ChatRecordItem } from '../../types/models'

const SYSTEM_MESSAGE_TYPES = [
  10000,        // 系统消息
  266287972401, // 拍一拍
]

function normalizeChatRecordText(value?: string): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hasRenderableChatRecordName(value?: string): boolean {
  return value !== undefined && value !== null && String(value).length > 0
}

export function toRenderableImageSrc(path?: string): string | undefined {
  const raw = String(path || '').trim()
  if (!raw) return undefined
  if (/^(data:|blob:|https?:|file:)/i.test(raw)) return raw

  const normalized = raw.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return encodeURI(`file:///${normalized}`)
  }
  if (normalized.startsWith('/')) {
    return encodeURI(`file://${normalized}`)
  }
  return raw
}

export function getChatRecordPreviewText(item: ChatRecordItem): string {
  const text = normalizeChatRecordText(item.datadesc) || normalizeChatRecordText(item.datatitle)
  if (item.datatype === 17) {
    return normalizeChatRecordText(item.chatRecordTitle) || normalizeChatRecordText(item.datatitle) || '聊天记录'
  }
  if (item.datatype === 2 || item.datatype === 3) return '[媒体消息]'
  if (item.datatype === 43) return '[视频]'
  if (item.datatype === 34) return '[语音]'
  if (item.datatype === 47) return '[表情]'
  return text || '[媒体消息]'
}

export function buildChatRecordPreviewItems(recordList: ChatRecordItem[], maxVisible = 3): ChatRecordItem[] {
  if (recordList.length <= maxVisible) return recordList.slice(0, maxVisible)
  const firstNestedIndex = recordList.findIndex(item => item.datatype === 17)
  if (firstNestedIndex < 0 || firstNestedIndex < maxVisible) {
    return recordList.slice(0, maxVisible)
  }
  if (maxVisible <= 1) {
    return [recordList[firstNestedIndex]]
  }
  return [
    ...recordList.slice(0, maxVisible - 1),
    recordList[firstNestedIndex]
  ]
}

export interface SolitaireEntry {
  index: string
  text: string
}

export interface SolitaireContent {
  title: string
  introLines: string[]
  entries: SolitaireEntry[]
}

export function parseSolitaireContent(rawTitle: string): SolitaireContent {
  const lines = String(rawTitle || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const title = lines[0] || '接龙'
  const introLines: string[] = []
  const entries: SolitaireEntry[] = []
  let hasStartedEntries = false

  for (const line of lines.slice(1)) {
    const entryMatch = /^(\d+)[.．、]\s*(.+)$/.exec(line)
    if (entryMatch) {
      hasStartedEntries = true
      entries.push({
        index: entryMatch[1],
        text: entryMatch[2].trim()
      })
      continue
    }

    if (hasStartedEntries && entries.length > 0) {
      const previous = entries[entries.length - 1]
      previous.text = `${previous.text} ${line}`.trim()
    } else {
      introLines.push(line)
    }
  }

  return { title, introLines, entries }
}

export function isRenderableImageSrc(value?: string | null): boolean {
  const src = String(value || '').trim()
  if (!src) return false
  return /^(https?:\/\/|data:image\/|blob:|file:\/\/|\/)/i.test(src)
}

export interface XmlField {
  key: string;
  value: string;
  type: 'attr' | 'node';
  tagName?: string;
  path: string;
}

export function parseXmlToFields(xml: string): XmlField[] {
  const fields: XmlField[] = []
  if (!xml || !xml.includes('<')) return []
  try {
    const parser = new DOMParser()
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return []

    const walk = (node: Node, path: string = '') => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        if (element.tagName === 'root') {
          node.childNodes.forEach((child) => walk(child, path))
          return
        }

        const currentPath = path ? `${path} > ${element.tagName}` : element.tagName

        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i]
          fields.push({
            key: attr.name,
            value: attr.value,
            type: 'attr',
            tagName: element.tagName,
            path: `${currentPath}[@${attr.name}]`
          })
        }

        if (element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE) {
          const text = element.textContent?.trim() || ''
          if (text) {
            fields.push({
              key: element.tagName,
              value: text,
              type: 'node',
              path: currentPath
            })
          }
        } else {
          node.childNodes.forEach((child, index) => walk(child, `${currentPath}[${index}]`))
        }
      }
    }
    doc.childNodes.forEach((node) => walk(node, ''))
  } catch (e) {
    console.warn('[XML Parse] Failed:', e)
  }
  return fields
}

export function updateXmlWithFields(xml: string, fields: XmlField[]): string {
  try {
    const parser = new DOMParser()
    const wrappedXml = xml.trim().startsWith('<?xml') ? xml : `<root>${xml}</root>`
    const doc = parser.parseFromString(wrappedXml, 'text/xml')
    const errorNode = doc.querySelector('parsererror')
    if (errorNode) return xml

    fields.forEach(f => {
      if (f.type === 'attr') {
        const elements = doc.getElementsByTagName(f.tagName!)
        if (elements.length > 0) {
          elements[0].setAttribute(f.key, f.value)
        }
      } else {
        const elements = doc.getElementsByTagName(f.key)
        if (elements.length > 0 && (elements[0].childNodes.length <= 1)) {
          elements[0].textContent = f.value
        }
      }
    })

    let result = new XMLSerializer().serializeToString(doc)
    if (!xml.trim().startsWith('<?xml')) {
      result = result.replace('<root>', '').replace('</root>', '').replace('<root/>', '')
    }
    return result
  } catch (e) {
    return xml
  }
}

export function isSystemMessage(localType: number): boolean {
  return SYSTEM_MESSAGE_TYPES.includes(localType)
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

export function cleanMessageContent(content: string): string {
  if (!content) return ''
  return content.trim()
}

export function normalizeMessageIdToken(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+(?=\d)/, '')
}

export function parsePositiveInteger(value: unknown): number | undefined {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

export function normalizeQuotedComparableText(value: unknown): string {
  const text = cleanMessageContent(String(value ?? '')).replace(/\s+/g, ' ').trim()
  return text.length > 160 ? text.slice(0, 160) : text
}
