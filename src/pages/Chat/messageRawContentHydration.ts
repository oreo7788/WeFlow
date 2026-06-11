import { useEffect, useMemo, useState } from 'react'
import type { Message } from '../../types/models'

const RAW_CONTENT_HYDRATION_TYPES = new Set([
  49,
  8589934592049,
  244813135921,
  21474836529
])

export function messageHasRawContent(message: Message | null | undefined): boolean {
  if (!message) return false
  return Boolean(String(message.rawContent || message.content || '').trim())
}

export function messageNeedsRawContentForRender(message: Message | null | undefined): boolean {
  if (!message || messageHasRawContent(message)) return false

  if (RAW_CONTENT_HYDRATION_TYPES.has(Number(message.localType))) {
    return true
  }

  if (Number(message.localType) === 48) {
    return !message.locationLat && !message.locationLabel && !message.locationPoiname
  }

  if (message.appMsgKind || message.linkTitle || message.fileName || message.quotedContent) {
    return true
  }

  return false
}

export async function fetchMessageDetail(
  sessionId: string,
  localId: number
): Promise<Message | null> {
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedLocalId = Math.floor(Number(localId) || 0)
  if (!normalizedSessionId || normalizedLocalId <= 0) return null

  try {
    const result = await window.electronAPI.chat.getMessage(normalizedSessionId, normalizedLocalId)
    if (!result.success || !result.message) return null
    return result.message
  } catch {
    return null
  }
}

export async function hydrateMessageRawContent(
  sessionId: string,
  message: Message
): Promise<Message> {
  if (!messageNeedsRawContentForRender(message)) return message

  const detail = await fetchMessageDetail(sessionId, message.localId)
  if (!detail) return message

  return {
    ...message,
    ...detail,
    messageKey: message.messageKey || detail.messageKey,
    senderDisplayName: message.senderDisplayName || detail.senderDisplayName,
    senderAvatarUrl: message.senderAvatarUrl || detail.senderAvatarUrl
  }
}

export function resolveMessageRawContent(message: Message, hydratedRawContent?: string): string {
  return hydratedRawContent || message.rawContent || message.content || ''
}

export function useMessageRawContent(message: Message, sessionId: string): {
  rawContent: string
  isHydratingRawContent: boolean
} {
  const [hydratedRawContent, setHydratedRawContent] = useState<string | undefined>(() => {
    const existing = resolveMessageRawContent(message)
    return existing || undefined
  })
  const [isHydratingRawContent, setIsHydratingRawContent] = useState(false)

  useEffect(() => {
    const existing = resolveMessageRawContent(message)
    setHydratedRawContent(existing || undefined)
  }, [message.messageKey, message.rawContent, message.content])

  useEffect(() => {
    if (!messageNeedsRawContentForRender(message)) return

    let cancelled = false
    setIsHydratingRawContent(true)

    void fetchMessageDetail(sessionId, message.localId).then((detail) => {
      if (cancelled) return
      const nextRawContent = resolveMessageRawContent(message, detail?.rawContent || detail?.content)
      if (nextRawContent) {
        setHydratedRawContent(nextRawContent)
      }
      setIsHydratingRawContent(false)
    })

    return () => {
      cancelled = true
    }
  }, [message.messageKey, message.localId, message.localType, message.rawContent, message.content, sessionId])

  const rawContent = useMemo(
    () => resolveMessageRawContent(message, hydratedRawContent),
    [hydratedRawContent, message]
  )

  return { rawContent, isHydratingRawContent }
}
