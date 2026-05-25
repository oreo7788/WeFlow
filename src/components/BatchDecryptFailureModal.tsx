import { createPortal } from 'react-dom'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useBatchDecryptFailureStore } from '../stores/batchDecryptFailureStore'
import type { BatchDecryptFailureItem } from '../types/batchDecryptFailure'
import './BatchDecryptFailureModal.scss'

function formatFailureTime(createTime?: number): string {
  if (!createTime) return '-'
  try {
    return new Date(createTime * 1000).toLocaleString('zh-CN')
  } catch {
    return '-'
  }
}

function formatFailureKind(kind: BatchDecryptFailureItem['failureKind']): string {
  if (kind === 'decrypt_failed') return '解密失败'
  if (kind === 'found') return '已找到'
  return '未找到'
}

function formatIdentity(item: BatchDecryptFailureItem): string {
  return item.imageMd5 || item.imageOriginSourceMd5 || item.imageDatName || '-'
}

interface BatchDecryptFailureModalProps {
  failures: BatchDecryptFailureItem[]
  onClose: () => void
  onJumpToMessage?: (item: BatchDecryptFailureItem) => void
}

function BatchDecryptFailureModalContent({
  failures,
  onClose,
  onJumpToMessage
}: BatchDecryptFailureModalProps) {
  const navigate = useNavigate()

  return (
    <div className="batch-decrypt-failure-overlay" onClick={onClose}>
      <div
        className="batch-decrypt-failure-modal"
        role="dialog"
        aria-modal="true"
        aria-label="批量解密失败详情"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="batch-decrypt-failure-header">
          <div className="batch-decrypt-failure-title">
            <AlertTriangle size={18} />
            <h3>批量解密失败详情</h3>
          </div>
          <button type="button" className="batch-decrypt-failure-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="batch-decrypt-failure-body">
          <p className="batch-decrypt-failure-hint">
            共 {failures.length} 条失败记录。可在独立页面查看完整历史，或定位到对应聊天消息。
          </p>
          <div className="batch-decrypt-failure-table-wrap">
            <table className="batch-decrypt-failure-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>会话</th>
                  <th>类型</th>
                  <th>标识</th>
                  <th>原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((item) => (
                  <tr key={item.id}>
                    <td>{formatFailureTime(item.createTime)}</td>
                    <td title={item.sessionName || item.sessionId || '-'}>
                      {item.sessionName || item.sessionId || '-'}
                    </td>
                    <td>
                      <span className={`failure-kind ${item.failureKind}`}>
                        {formatFailureKind(item.failureKind)}
                      </span>
                    </td>
                    <td title={formatIdentity(item)}>{formatIdentity(item)}</td>
                    <td title={item.error || '-'}>{item.error || '-'}</td>
                    <td>
                      {item.sessionId && onJumpToMessage ? (
                        <button
                          type="button"
                          className="failure-action-btn"
                          onClick={() => onJumpToMessage(item)}
                        >
                          定位消息
                        </button>
                      ) : (
                        <span className="failure-action-muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="batch-decrypt-failure-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              onClose()
              navigate('/decrypt-failures')
            }}
          >
            <ExternalLink size={14} />
            在独立页查看全部
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            知道了
          </button>
        </footer>
      </div>
    </div>
  )
}

export function BatchDecryptFailureModalHost({
  onJumpToMessage
}: {
  onJumpToMessage?: (item: BatchDecryptFailureItem) => void
}) {
  const showFailureModal = useBatchDecryptFailureStore(state => state.showFailureModal)
  const modalFailures = useBatchDecryptFailureStore(state => state.modalFailures)
  const closeFailureModal = useBatchDecryptFailureStore(state => state.closeFailureModal)

  if (!showFailureModal || modalFailures.length === 0) return null

  return createPortal(
    <BatchDecryptFailureModalContent
      failures={modalFailures}
      onClose={closeFailureModal}
      onJumpToMessage={onJumpToMessage}
    />,
    document.body
  )
}

export { formatFailureKind, formatFailureTime, formatIdentity }
