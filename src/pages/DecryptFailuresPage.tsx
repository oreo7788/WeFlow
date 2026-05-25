import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Loader2, MessageSquare, RefreshCw, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  formatFailureKind,
  formatFailureTime,
  formatIdentity
} from '../components/BatchDecryptFailureModal'
import { useBatchDecryptFailureStore } from '../stores/batchDecryptFailureStore'
import { useChatStore } from '../stores/chatStore'
import type { BatchDecryptFailureItem } from '../types/batchDecryptFailure'
import './DecryptFailuresPage.scss'

type FailureFilter = 'all' | 'not_found' | 'decrypt_failed' | 'found'

function hasImageLocator(item: Pick<BatchDecryptFailureItem, 'imageMd5' | 'imageOriginSourceMd5' | 'imageDatName'>): boolean {
  return Boolean(item.imageMd5 || item.imageOriginSourceMd5 || item.imageDatName)
}

function DecryptFailuresPage() {
  const navigate = useNavigate()
  const hydrate = useBatchDecryptFailureStore(state => state.hydrate)
  const failures = useBatchDecryptFailureStore(state => state.failures)
  const lastSummary = useBatchDecryptFailureStore(state => state.lastSummary)
  const clearFailures = useBatchDecryptFailureStore(state => state.clearFailures)
  const removeFailure = useBatchDecryptFailureStore(state => state.removeFailure)
  const updateFailure = useBatchDecryptFailureStore(state => state.updateFailure)
  const setCurrentSession = useChatStore(state => state.setCurrentSession)
  const setPendingMessageJump = useChatStore(state => state.setPendingMessageJump)

  const [filter, setFilter] = useState<FailureFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const filteredFailures = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase()
    return failures.filter((item) => {
      if (filter !== 'all' && item.failureKind !== filter) return false
      if (!normalizedKeyword) return true
      const haystack = [
        item.sessionName,
        item.sessionId,
        item.imageMd5,
        item.imageOriginSourceMd5,
        item.imageDatName,
        item.error,
        item.senderUsername,
        item.localId ? String(item.localId) : ''
      ].join(' ').toLowerCase()
      return haystack.includes(normalizedKeyword)
    })
  }, [failures, filter, keyword])

  const stats = useMemo(() => ({
    total: failures.length,
    notFound: failures.filter(item => item.failureKind === 'not_found').length,
    decryptFailed: failures.filter(item => item.failureKind === 'decrypt_failed').length,
    found: failures.filter(item => item.failureKind === 'found').length
  }), [failures])

  const jumpToMessage = useCallback((item: BatchDecryptFailureItem) => {
    if (!item.sessionId) return
    setPendingMessageJump({
      sourceMessageKey: item.id,
      sourceCreateTime: item.createTime || 0,
      sessionId: item.sessionId,
      localId: item.localId,
      createTime: item.createTime,
      senderUsername: item.senderUsername
    })
    setCurrentSession(item.sessionId)
    navigate('/chat')
  }, [navigate, setCurrentSession, setPendingMessageJump])

  const handleClearAll = useCallback(() => {
    if (failures.length === 0) return
    if (!window.confirm(`确定清空全部 ${failures.length} 条失败记录吗？`)) return
    clearFailures()
  }, [clearFailures, failures.length])

  const retryFailure = useCallback(async (item: BatchDecryptFailureItem) => {
    if (item.failureKind === 'found' || retryingIds.has(item.id)) return
    if (!item.sessionId || !hasImageLocator(item)) {
      window.alert('缺少会话或图片标识，无法重试')
      return
    }

    setRetryingIds((prev) => {
      const next = new Set(prev)
      next.add(item.id)
      return next
    })

    try {
      const result = await window.electronAPI.image.decrypt({
        sessionId: item.sessionId,
        imageMd5: item.imageMd5,
        imageOriginSourceMd5: item.imageOriginSourceMd5,
        imageDatName: item.imageDatName,
        createTime: item.createTime,
        force: true,
        preferFilePath: true,
        hardlinkOnly: true,
        allowCacheIndex: true,
        suppressEvents: true
      })
      if (result?.success) {
        updateFailure(item.id, {
          failureKind: 'found',
          error: undefined
        })
        return
      }
      updateFailure(item.id, {
        failureKind: result?.failureKind === 'decrypt_failed' ? 'decrypt_failed' : 'not_found',
        error: result?.error || '重试解密失败'
      })
    } catch (error) {
      updateFailure(item.id, {
        failureKind: 'not_found',
        error: String(error)
      })
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }, [retryingIds, updateFailure])

  return (
    <div className="decrypt-failures-page">
      <header className="decrypt-failures-header">
        <button type="button" className="back-btn" onClick={() => navigate(-1)}>
          <ArrowLeft size={16} />
          返回
        </button>
        <div className="header-main">
          <h1>
            <AlertTriangle size={20} />
            解密失败记录
          </h1>
          <p>展示图片批量解密时未找到或解密失败的数据，便于定位对应聊天消息。</p>
        </div>
        <button
          type="button"
          className="clear-btn"
          onClick={handleClearAll}
          disabled={failures.length === 0}
        >
          <Trash2 size={14} />
          清空记录
        </button>
      </header>

      {lastSummary && (
        <section className="decrypt-failures-summary">
          最近一次批量解密：
          成功 {lastSummary.success}，
          未找到 {lastSummary.notFound}，
          解密失败 {lastSummary.decryptFailed}
          {lastSummary.sessionName ? `（${lastSummary.sessionName}）` : ''}
        </section>
      )}

      <section className="decrypt-failures-toolbar">
        <div className="filter-group">
          <button
            type="button"
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            全部 ({stats.total})
          </button>
          <button
            type="button"
            className={filter === 'not_found' ? 'active' : ''}
            onClick={() => setFilter('not_found')}
          >
            未找到 ({stats.notFound})
          </button>
          <button
            type="button"
            className={filter === 'decrypt_failed' ? 'active' : ''}
            onClick={() => setFilter('decrypt_failed')}
          >
            解密失败 ({stats.decryptFailed})
          </button>
          <button
            type="button"
            className={filter === 'found' ? 'active' : ''}
            onClick={() => setFilter('found')}
          >
            已找到 ({stats.found})
          </button>
        </div>
        <input
          type="search"
          className="search-input"
          placeholder="搜索会话、MD5、错误信息..."
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </section>

      {filteredFailures.length === 0 ? (
        <div className="decrypt-failures-empty">
          <AlertTriangle size={28} />
          <p>{failures.length === 0 ? '暂无失败记录' : '没有匹配的记录'}</p>
        </div>
      ) : (
        <div className="decrypt-failures-table-wrap">
          <table className="decrypt-failures-table">
            <thead>
              <tr>
                <th>记录时间</th>
                <th>消息时间</th>
                <th>来源</th>
                <th>会话</th>
                <th>localId</th>
                <th>类型</th>
                <th>图片标识</th>
                <th>错误原因</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredFailures.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.recordedAt).toLocaleString('zh-CN')}</td>
                  <td>{formatFailureTime(item.createTime)}</td>
                  <td>{item.sourcePage === 'chat' ? '聊天页' : '资源页'}</td>
                  <td title={item.sessionName || item.sessionId || '-'}>
                    {item.sessionName || item.sessionId || '-'}
                  </td>
                  <td>{item.localId || '-'}</td>
                  <td>
                    <span className={`failure-kind ${item.failureKind}`}>
                      {formatFailureKind(item.failureKind)}
                    </span>
                  </td>
                  <td title={formatIdentity(item)}>{formatIdentity(item)}</td>
                  <td title={item.error || '-'}>{item.error || '-'}</td>
                  <td className="action-cell">
                    {item.sessionId ? (
                      <button type="button" className="link-btn" onClick={() => jumpToMessage(item)}>
                        <MessageSquare size={13} />
                        定位消息
                      </button>
                    ) : null}
                    {item.failureKind !== 'found' && (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={retryingIds.has(item.id)}
                        onClick={() => void retryFailure(item)}
                      >
                        {retryingIds.has(item.id) ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        重试
                      </button>
                    )}
                    <button type="button" className="link-btn danger" onClick={() => removeFailure(item.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default DecryptFailuresPage
