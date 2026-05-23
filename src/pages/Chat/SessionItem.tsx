import React, { useMemo } from 'react'
import { BellOff, MessageSquare, Newspaper } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import type { ChatSession } from '../../types/models'
import { OFFICIAL_ACCOUNTS_VIRTUAL_ID } from './chatSessionConstants'

const HighlightText = React.memo(({ text, keyword }: { text: string; keyword: string }) => {
  if (!keyword) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const matchIndex = lowerText.indexOf(lowerKeyword)

  if (matchIndex === -1) return <>{text}</>

  const maxLength = 50
  let displayText = text

  if (text.length > maxLength && matchIndex > 20) {
    const start = Math.max(0, matchIndex - 15)
    displayText = '...' + text.slice(start)
  }

  const parts = displayText.split(new RegExp(`(${keyword})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lowerKeyword ?
          <span key={i} className="highlight">{part}</span> : part
      )}
    </>
  )
})

export const HighlightTextNoTruncate = React.memo(({ text, keyword }: { text: string; keyword: string }) => {
  if (!keyword) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const matchIndex = lowerText.indexOf(lowerKeyword)

  if (matchIndex === -1) return <>{text}</>

  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matchEnd = matchIndex + keyword.length
  const maxDisplayLength = 25

  if (matchIndex > 5 || text.length > maxDisplayLength) {
    const start = Math.max(0, matchIndex - 8)
    const end = Math.min(text.length, matchEnd + 15)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < text.length ? '...' : ''
    const middleText = text.slice(start, end)

    const parts = middleText.split(new RegExp(`(${escapedKeyword})`, 'gi'))
    return (
      <>
        {prefix}
        {parts.map((part, i) =>
          part.toLowerCase() === lowerKeyword ?
            <span key={i} className="highlight">{part}</span> : part
        )}
        {suffix}
      </>
    )
  }

  const parts = text.split(new RegExp(`(${escapedKeyword})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lowerKeyword ?
          <span key={i} className="highlight">{part}</span> : part
      )}
    </>
  )
})

export interface SessionItemProps {
  session: ChatSession
  isActive: boolean
  onSelect: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
  searchKeyword?: string
}

const SessionItem = React.memo(function SessionItem({
  session,
  isActive,
  onSelect,
  formatTime,
  searchKeyword
}: SessionItemProps) {
  const timeText = useMemo(() =>
    formatTime(session.lastTimestamp || session.sortTimestamp),
    [formatTime, session.lastTimestamp, session.sortTimestamp]
  )

  const isFoldEntry = session.username.toLowerCase().includes('placeholder_foldgroup')
  const isBizEntry = session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID

  if (isFoldEntry) {
    return (
      <div
        className={`session-item fold-entry ${isActive ? 'active' : ''}`}
        onClick={() => onSelect(session)}
      >
        <div className="fold-entry-avatar">
          <MessageSquare size={22} />
        </div>
        <div className="session-info">
          <div className="session-top">
            <span className="session-name">折叠的聊天</span>
            <span className="session-time">{timeText}</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">{session.summary || '暂无消息'}</span>
          </div>
        </div>
      </div>
    )
  }

  if (isBizEntry) {
    return (
      <div
        className={`session-item biz-entry ${isActive ? 'active' : ''}`}
        onClick={() => onSelect(session)}
      >
        <div className="biz-entry-avatar">
          <Newspaper size={22} />
        </div>
        <div className="session-info">
          <div className="session-top">
            <span className="session-name">订阅号/服务号</span>
            <span className="session-time">{timeText}</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">{session.summary || '查看公众号历史消息'}</span>
            <div className="session-badges">
              {session.unreadCount > 0 && (
                <span className="unread-badge">
                  {session.unreadCount > 99 ? '99+' : session.unreadCount}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const summaryContent = useMemo(() => {
    if (session.matchedField === 'wxid') {
      return <span className="session-summary">wxid：<HighlightTextNoTruncate text={session.username} keyword={searchKeyword || ''} /></span>
    } else if (session.matchedField === 'alias' && session.alias) {
      return <span className="session-summary">微信号：<HighlightTextNoTruncate text={session.alias} keyword={searchKeyword || ''} /></span>
    }
    return <span className="session-summary">{session.summary || '暂无消息'}</span>
  }, [session.matchedField, session.username, session.alias, session.summary, searchKeyword])

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''} ${session.isMuted ? 'muted' : ''}`}
      onClick={() => onSelect(session)}
    >
      <Avatar
        src={session.avatarUrl}
        name={session.displayName || session.username}
        size={48}
        className={session.username.includes('@chatroom') ? 'group' : ''}
      />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">
            {(() => {
              const shouldHighlight = (session.matchedField as any) === 'name' && searchKeyword
              return shouldHighlight ? (
                <HighlightText text={session.displayName || session.username} keyword={searchKeyword} />
              ) : (
                session.displayName || session.username
              )
            })()}
          </span>
          <span className="session-time">{timeText}</span>
        </div>
        <div className="session-bottom">
          {summaryContent}
          <div className="session-badges">
            {session.isMuted && <BellOff size={12} className="mute-icon" />}
            {session.unreadCount > 0 && (
              <span className={`unread-badge ${session.isMuted ? 'muted' : ''}`}>
                {session.unreadCount > 99 ? '99+' : session.unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl &&
    prevProps.session.summary === nextProps.session.summary &&
    prevProps.session.matchedField === nextProps.session.matchedField &&
    prevProps.session.alias === nextProps.session.alias &&
    prevProps.session.unreadCount === nextProps.session.unreadCount &&
    prevProps.session.lastTimestamp === nextProps.session.lastTimestamp &&
    prevProps.session.sortTimestamp === nextProps.session.sortTimestamp &&
    prevProps.session.isMuted === nextProps.session.isMuted &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.searchKeyword === nextProps.searchKeyword
  )
})

export default SessionItem
