import { useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { ChatSession } from '../../types/models'
import SessionItem from './SessionItem'
import { OFFICIAL_ACCOUNTS_VIRTUAL_ID } from './chatSessionConstants'

interface VirtualSessionListProps {
  sessions: ChatSession[]
  currentSessionId: string | null
  bizView: boolean
  searchKeyword: string
  onSelect: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
  onScrollingChange?: (scrolling: boolean) => void
}

export default function VirtualSessionList({
  sessions,
  currentSessionId,
  bizView,
  searchKeyword,
  onSelect,
  formatTime,
  onScrollingChange
}: VirtualSessionListProps) {
  const handleIsScrolling = useCallback((scrolling: boolean) => {
    onScrollingChange?.(scrolling)
  }, [onScrollingChange])

  const renderItem = useCallback((index: number, session: ChatSession) => (
    <SessionItem
      key={session.username}
      session={session}
      isActive={currentSessionId === session.username || (bizView && session.username === OFFICIAL_ACCOUNTS_VIRTUAL_ID)}
      onSelect={onSelect}
      formatTime={formatTime}
      searchKeyword={searchKeyword}
    />
  ), [bizView, currentSessionId, formatTime, onSelect, searchKeyword])

  return (
    <Virtuoso
      className="session-list"
      style={{ height: '100%' }}
      data={sessions}
      computeItemKey={(_index, session) => session.username}
      itemContent={renderItem}
      isScrolling={handleIsScrolling}
      overscan={240}
    />
  )
}
