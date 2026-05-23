export interface QuotedMessageJumpTarget {
  sourceMessageKey: string
  sourceCreateTime: number
  sessionId: string
  localId?: number
  serverId?: string
  createTime?: number
  senderUsername?: string
  content?: string
}
