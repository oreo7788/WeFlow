export type BatchDecryptFailureKind = 'not_found' | 'decrypt_failed' | 'found'

export type BatchDecryptFailureSourcePage = 'chat' | 'resources'

export interface BatchDecryptFailureItem {
  id: string
  sourcePage: BatchDecryptFailureSourcePage
  sessionId?: string
  sessionName?: string
  localId?: number
  senderUsername?: string
  createTime?: number
  imageMd5?: string
  imageOriginSourceMd5?: string
  imageDatName?: string
  failureKind: BatchDecryptFailureKind
  error?: string
  recordedAt: number
}

export interface BatchDecryptFailureSummary {
  success: number
  notFound: number
  decryptFailed: number
  recordedAt: number
  sourcePage: BatchDecryptFailureSourcePage
  sessionName?: string
}
