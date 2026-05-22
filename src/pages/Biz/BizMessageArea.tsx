import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useThemeStore } from '../../stores/themeStore'
import { Newspaper, MessageSquareOff } from 'lucide-react'
import type { BizAccount } from './types'
import '../BizPage.scss'

export const BizMessageArea: React.FC<{
  account: BizAccount | null
}> = ({ account }) => {
  const themeMode = useThemeStore((state) => state.themeMode)
  const [messages, setMessages] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const limit = 20
  const messageListRef = useRef<HTMLDivElement>(null)
  const lastScrollHeightRef = useRef<number>(0)
  const isInitialLoadRef = useRef<boolean>(true)
  const [myWxid, setMyWxid] = useState<string>('')

  useEffect(() => {
    const initWxid = async () => {
      try {
        const wxid = await window.electronAPI.config.get('myWxid')
        if (wxid) {
          setMyWxid(wxid as string)
        }
      } catch {
        // ignore
      }
    }
    void initWxid()
  }, [])

  const isDark = useMemo(() => {
    if (themeMode === 'dark') return true
    if (themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  }, [themeMode])

  const loadMessages = async (username: string, currentOffset: number) => {
    if (loading || !myWxid) return

    setLoading(true)
    if (messageListRef.current) {
      lastScrollHeightRef.current = messageListRef.current.scrollHeight
    }

    try {
      let res
      if (username === 'gh_3dfda90e39d6') {
        res = await window.electronAPI.biz.listPayRecords(myWxid, limit, currentOffset)
      } else {
        res = await window.electronAPI.biz.listMessages(username, myWxid, limit, currentOffset)
      }

      if (res) {
        if (res.length < limit) setHasMore(false)

        setMessages((prev) => {
          const combined = currentOffset === 0 ? res : [...res, ...prev]
          const uniqueMessages = Array.from(new Map(combined.map((item) => [item.local_id || item.create_time, item])).values())
          return uniqueMessages.sort((a, b) => a.create_time - b.create_time)
        })
        setOffset(currentOffset + limit)
      }
    } catch (err) {
      console.error('加载消息失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (account && myWxid) {
      setMessages([])
      setOffset(0)
      setHasMore(true)
      isInitialLoadRef.current = true
      void loadMessages(account.username, 0)
    }
  }, [account, myWxid])

  useEffect(() => {
    if (!messageListRef.current) return

    if (isInitialLoadRef.current && messages.length > 0) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight
      isInitialLoadRef.current = false
    } else if (messages.length > 0 && !isInitialLoadRef.current && !loading) {
      const newScrollHeight = messageListRef.current.scrollHeight
      const heightDiff = newScrollHeight - lastScrollHeightRef.current
      if (heightDiff > 0 && messageListRef.current.scrollTop < 100) {
        messageListRef.current.scrollTop += heightDiff
      }
    }
  }, [messages, loading])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    if (target.scrollTop < 50) {
      if (!loading && hasMore && account) {
        void loadMessages(account.username, offset)
      }
    }
  }

  if (!account) {
    return (
      <div className="biz-empty-state">
        <div className="empty-icon"><Newspaper size={40} /></div>
        <p>请选择一个服务号查看消息</p>
      </div>
    )
  }

  const formatMessageTime = (timestamp: number) => {
    if (!timestamp) return ''
    const date = new Date(timestamp * 1000)
    const now = new Date()

    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
    }

    const isThisYear = date.getFullYear() === now.getFullYear()
    if (isThisYear) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
    }

    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }

  const defaultImage = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMTgwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iI2Y1ZjVmNSIvPjwvc3ZnPg=='

  return (
    <div className={`biz-main ${isDark ? 'dark' : ''}`}>
      <div className="main-header">
        <h2>{account.name}</h2>
      </div>
      <div className="message-container" onScroll={handleScroll} ref={messageListRef}>
        <div className="messages-wrapper">
          {hasMore && messages.length > 0 && (
            <div className="biz-loading-more">{loading ? '加载中...' : '向上滚动加载更多历史消息'}</div>
          )}
          {!loading && messages.length === 0 && (
            <div className="biz-no-record-container">
              <div className="no-record-icon">
                <MessageSquareOff size={48} />
              </div>
              <h3>暂无本地记录</h3>
              <p>该公众号在当前数据库中没有可显示的聊天历史</p>
            </div>
          )}
          {messages.map((msg, index) => {
            const showTime = true

            return (
              <div key={msg.local_id || index}>
                {showTime && (
                  <div className="time-divider">
                    <span>{formatMessageTime(msg.create_time)}</span>
                  </div>
                )}

                {account.username === 'gh_3dfda90e39d6' ? (
                  <div className="pay-card">
                    <div className="pay-header">
                      {msg.merchant_icon ? <img src={msg.merchant_icon} className="pay-icon" alt="" /> : <div className="pay-icon-placeholder">¥</div>}
                      <span>{msg.merchant_name || '微信支付'}</span>
                    </div>
                    <div className="pay-title">{msg.title}</div>
                    <div className="pay-desc">{msg.description}</div>
                  </div>
                ) : (
                  <div className="article-card">
                    <div onClick={() => window.electronAPI.shell.openExternal(msg.url)} className="main-article">
                      <img src={msg.cover || defaultImage} className="article-cover" alt="" />
                      <div className="article-overlay"><h3 className="article-title">{msg.title}</h3></div>
                    </div>
                    {msg.des && <div className="article-digest">{msg.des}</div>}
                    {msg.content_list && msg.content_list.length > 1 && (
                      <div className="sub-articles">
                        {msg.content_list.slice(1).map((item: any, idx: number) => (
                          <div key={idx} onClick={() => window.electronAPI.shell.openExternal(item.url)} className="sub-item">
                            <span className="sub-title">{item.title}</span>
                            {item.cover && <img src={item.cover} className="sub-cover" alt="" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {loading && offset === 0 && <div className="biz-loading-more">加载中...</div>}
        </div>
      </div>
    </div>
  )
}
