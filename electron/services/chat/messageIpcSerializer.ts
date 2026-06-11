import type { Message } from './types'
import { estimateJsonBytes, logPerf, nowMs } from '../../utils/perfLogger'

function estimateMessagePayloadBytes(message: Message): number {
  return estimateJsonBytes(message)
}

export function slimMessageForListIpc(message: Message): Message {
  if (!message.rawContent && !message.content) {
    return message
  }

  const { rawContent: _rawContent, content: _content, ...rest } = message
  return rest
}

export function slimMessagesForListIpc(messages: Message[], context: { sessionId?: string; source?: string } = {}): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages

  const startedAt = nowMs()
  let payloadBytesBefore = 0
  let payloadBytesAfter = 0
  let strippedCount = 0

  const slimmed = messages.map((message) => {
    payloadBytesBefore += estimateMessagePayloadBytes(message)
    if (message.rawContent || message.content) {
      strippedCount += 1
    }
    const next = slimMessageForListIpc(message)
    payloadBytesAfter += estimateMessagePayloadBytes(next)
    return next
  })

  logPerf('messageIpc', 'slimMessagesForListIpc', nowMs() - startedAt, {
    sessionId: context.sessionId || '',
    source: context.source || 'list',
    count: messages.length,
    strippedCount,
    payloadBytesBefore,
    payloadBytesAfter,
    savedBytes: Math.max(0, payloadBytesBefore - payloadBytesAfter)
  })

  return slimmed
}
