import React, { useState, useEffect, useMemo, useCallback } from 'react'
import type { BizAccount } from './types'
import '../BizPage.scss'

export const BizAccountList: React.FC<{
  onSelect: (account: BizAccount) => void
  selectedUsername?: string
  searchKeyword?: string
}> = ({ onSelect, selectedUsername, searchKeyword }) => {
  const [accounts, setAccounts] = useState<BizAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [myWxid, setMyWxid] = useState<string>('')

  useEffect(() => {
    const initWxid = async () => {
      try {
        const wxid = await window.electronAPI.config.get('myWxid')
        if (wxid) {
          setMyWxid(wxid as string)
        }
      } catch (e) {
        console.error('获取 myWxid 失败:', e)
      }
    }
    void initWxid()
  }, [])

  const fetchAccounts = useCallback(async () => {
    if (!myWxid) return

    setLoading(true)
    try {
      const res = await window.electronAPI.biz.listAccounts(myWxid)
      setAccounts(res || [])
    } catch (err) {
      console.error('获取服务号列表失败:', err)
    } finally {
      setLoading(false)
    }
  }, [myWxid])

  useEffect(() => {
    void fetchAccounts()
  }, [fetchAccounts])

  useEffect(() => {
    if (!window.electronAPI.chat.onWcdbChange) return
    const removeListener = window.electronAPI.chat.onWcdbChange((_event: unknown, data: { json?: string }) => {
      try {
        const payload = JSON.parse(data.json || '{}')
        const tableName = String(payload.table || '').toLowerCase()
        if (!tableName || tableName === 'session' || tableName.includes('message') || tableName.startsWith('msg_')) {
          void fetchAccounts()
        }
      } catch {
        void fetchAccounts()
      }
    })
    return () => removeListener()
  }, [fetchAccounts])

  const filtered = useMemo(() => {
    let result = accounts
    if (searchKeyword) {
      const q = searchKeyword.toLowerCase()
      result = accounts.filter((a) =>
        (a.name && a.name.toLowerCase().includes(q)) ||
        (a.username && a.username.toLowerCase().includes(q))
      )
    }
    return result.sort((a, b) => {
      if (a.username === 'gh_3dfda90e39d6') return -1
      if (b.username === 'gh_3dfda90e39d6') return 1
      return b.last_time - a.last_time
    })
  }, [accounts, searchKeyword])

  if (loading) return <div className="biz-loading">加载中...</div>

  return (
    <div className="biz-account-list">
      {filtered.map((item) => (
        <div
          key={item.username}
          onClick={() => {
            setAccounts((prev) => prev.map((account) =>
              account.username === item.username ? { ...account, unread_count: 0 } : account
            ))
            onSelect({ ...item, unread_count: 0 })
          }}
          className={`biz-account-item ${selectedUsername === item.username ? 'active' : ''} ${item.username === 'gh_3dfda90e39d6' ? 'pay-account' : ''}`}
        >
          <img src={item.avatar} className="biz-avatar" alt="" />
          {(item.unread_count || 0) > 0 && (
            <span className="biz-unread-badge">{(item.unread_count || 0) > 99 ? '99+' : item.unread_count}</span>
          )}
          <div className="biz-info">
            <div className="biz-info-top">
              <span className="biz-name">{item.name || item.username}</span>
              <span className="biz-time">{item.formatted_last_time}</span>
            </div>
            <div className={`biz-badge ${
              item.type === '1' ? 'type-service' :
                item.type === '0' ? 'type-sub' :
                  item.type === '2' ? 'type-enterprise' :
                    item.type === '3' ? 'type-enterprise' : 'type-unknown'
            }`}>
              {item.type === '0' ? '公众号' : item.type === '1' ? '服务号' : item.type === '2' ? '企业号' : item.type === '3' ? '企业附属' : '未知'}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
