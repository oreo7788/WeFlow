import { create } from 'zustand'
import {
  BATCH_DECRYPT_FAILURE_MODAL_MAX,
  BATCH_DECRYPT_FAILURE_STORAGE_MAX
} from '../constants/imageDecrypt'
import type {
  BatchDecryptFailureItem,
  BatchDecryptFailureSourcePage,
  BatchDecryptFailureSummary
} from '../types/batchDecryptFailure'

const STORAGE_KEY = 'weflow.batchDecryptFailures.v1'

interface BatchDecryptFailureState {
  failures: BatchDecryptFailureItem[]
  lastSummary: BatchDecryptFailureSummary | null
  showFailureModal: boolean
  modalFailures: BatchDecryptFailureItem[]
  hydrated: boolean

  hydrate: () => void
  appendFailures: (items: BatchDecryptFailureItem[]) => void
  clearFailures: () => void
  removeFailure: (id: string) => void
  updateFailure: (id: string, patch: Partial<Pick<BatchDecryptFailureItem, 'failureKind' | 'error'>>) => void
  setLastSummary: (summary: BatchDecryptFailureSummary) => void
  openFailureModal: (items: BatchDecryptFailureItem[]) => void
  closeFailureModal: () => void
}

function readStoredFailures(): BatchDecryptFailureItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is BatchDecryptFailureItem => (
      item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      (item.failureKind === 'not_found' || item.failureKind === 'decrypt_failed' || item.failureKind === 'found')
    ))
  } catch {
    return []
  }
}

function writeStoredFailures(failures: BatchDecryptFailureItem[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(failures))
  } catch {
    // ignore quota errors
  }
}

function createFailureId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function buildBatchDecryptFailureItem(
  input: Omit<BatchDecryptFailureItem, 'id' | 'recordedAt'> & { id?: string; recordedAt?: number }
): BatchDecryptFailureItem {
  return {
    id: input.id || createFailureId(),
    sourcePage: input.sourcePage,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    localId: input.localId,
    senderUsername: input.senderUsername,
    createTime: input.createTime,
    imageMd5: input.imageMd5,
    imageOriginSourceMd5: input.imageOriginSourceMd5,
    imageDatName: input.imageDatName,
    failureKind: input.failureKind,
    error: input.error,
    recordedAt: input.recordedAt || Date.now()
  }
}

export interface BatchDecryptCompleteInput {
  success: number
  notFound: number
  decryptFailed: number
  failures: BatchDecryptFailureItem[]
  sourcePage: BatchDecryptFailureSourcePage
  sessionName?: string
  onNotify: (message: string, title: string) => void
}

export interface BatchDecryptCompleteResult {
  totalFailures: number
  openedModal: boolean
}

export function handleBatchDecryptComplete(input: BatchDecryptCompleteInput): BatchDecryptCompleteResult {
  const store = useBatchDecryptFailureStore.getState()
  const totalFailures = Math.max(0, input.notFound + input.decryptFailed)

  store.setLastSummary({
    success: input.success,
    notFound: input.notFound,
    decryptFailed: input.decryptFailed,
    recordedAt: Date.now(),
    sourcePage: input.sourcePage,
    sessionName: input.sessionName
  })

  if (input.failures.length > 0) {
    store.appendFailures(input.failures)
  }

  if (totalFailures === 0) {
    if (input.success > 0) {
      input.onNotify(`批量解密完成：成功 ${input.success}`, '批量解密完成')
    }
    return { totalFailures, openedModal: false }
  }

  if (totalFailures <= BATCH_DECRYPT_FAILURE_MODAL_MAX) {
    store.openFailureModal(input.failures)
    return { totalFailures, openedModal: true }
  }

  input.onNotify(
    `批量解密完成：成功 ${input.success}，失败 ${totalFailures} 条（未找到 ${input.notFound}，解密失败 ${input.decryptFailed}）。失败较多，请前往「解密失败记录」页面查看。`,
    '批量解密完成'
  )
  return { totalFailures, openedModal: false }
}

export const useBatchDecryptFailureStore = create<BatchDecryptFailureState>((set, get) => ({
  failures: [],
  lastSummary: null,
  showFailureModal: false,
  modalFailures: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return
    set({ failures: readStoredFailures(), hydrated: true })
  },

  appendFailures: (items) => {
    if (!Array.isArray(items) || items.length === 0) return
    const merged = [...items, ...get().failures]
      .sort((a, b) => b.recordedAt - a.recordedAt)
      .slice(0, BATCH_DECRYPT_FAILURE_STORAGE_MAX)
    writeStoredFailures(merged)
    set({ failures: merged })
  },

  clearFailures: () => {
    writeStoredFailures([])
    set({ failures: [] })
  },

  removeFailure: (id) => {
    const next = get().failures.filter(item => item.id !== id)
    writeStoredFailures(next)
    set({ failures: next })
  },

  updateFailure: (id, patch) => {
    const next = get().failures.map((item) => (
      item.id === id ? { ...item, ...patch } : item
    ))
    writeStoredFailures(next)
    set({ failures: next })
  },

  setLastSummary: (summary) => set({ lastSummary: summary }),

  openFailureModal: (items) => set({
    showFailureModal: true,
    modalFailures: items
  }),

  closeFailureModal: () => set({
    showFailureModal: false,
    modalFailures: []
  })
}))
