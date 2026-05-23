import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { AlertCircle, Loader2, Play, Pause, Image as ImageIcon, Check, Hash, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'
import { getEmojiPath } from 'wechat-emojis'
import { LivePhotoIcon } from '../../components/LivePhotoIcon'
import { AnimatedStreamingText } from '../../components/AnimatedStreamingText'
import type { ChatSession, Message } from '../../types/models'
import * as configService from '../../services/config'
import ChatMessageBubble from './ChatMessageBubble'
import {
  EMOJI_CACHE_MAX_BYTES,
  EMOJI_CACHE_MAX_ENTRIES,
  IMAGE_CACHE_MAX_BYTES,
  IMAGE_CACHE_MAX_ENTRIES,
  SENDER_AVATAR_CACHE_MAX_ENTRIES,
  VOICE_CACHE_MAX_BYTES,
  VOICE_CACHE_MAX_ENTRIES,
  VOICE_TRANSCRIPT_CACHE_MAX_BYTES,
  VOICE_TRANSCRIPT_CACHE_MAX_ENTRIES,
  createBoundedCache,
  enqueueAutoMediaTask,
  estimateStringBytes,
  scheduleWhenIdle
} from './chatPageCacheUtils'
import {
  toRenderableImageSrc,
  isRenderableImageSrc,
  isSystemMessage,
  formatFileSize,
  parseSolitaireContent,
  getChatRecordPreviewText,
  buildChatRecordPreviewItems,
  normalizeMessageIdToken,
  parsePositiveInteger,
  normalizeQuotedComparableText,
  hasRenderableChatRecordName
} from './chatMessageUtils'
import {
  resolveQuotedSenderDisplayName,
  resolveQuotedSenderUsername,
  resolveQuotedSenderFallbackDisplayName
} from './quotedSenderUtils'
import type { QuotedMessageJumpTarget } from './messageBubbleTypes'

// 全局语音播放管理器：同一时间只能播放一条语音
const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    // 停止当前正在播放的语音
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

// 前端表情包缓存
const emojiDataUrlCache = createBoundedCache<string>({
  maxEntries: EMOJI_CACHE_MAX_ENTRIES,
  maxBytes: EMOJI_CACHE_MAX_BYTES,
  estimate: estimateStringBytes
})
const imageDataUrlCache = createBoundedCache<string>({
  maxEntries: IMAGE_CACHE_MAX_ENTRIES,
  maxBytes: IMAGE_CACHE_MAX_BYTES,
  estimate: estimateStringBytes
})
const voiceDataUrlCache = createBoundedCache<string>({
  maxEntries: VOICE_CACHE_MAX_ENTRIES,
  maxBytes: VOICE_CACHE_MAX_BYTES,
  estimate: estimateStringBytes
})
const voiceTranscriptCache = createBoundedCache<string>({
  maxEntries: VOICE_TRANSCRIPT_CACHE_MAX_ENTRIES,
  maxBytes: VOICE_TRANSCRIPT_CACHE_MAX_BYTES,
  estimate: estimateStringBytes
})
type SharedImageDecryptResult = {
  success: boolean
  localPath?: string
  liveVideoPath?: string
  error?: string
  failureKind?: 'not_found' | 'decrypt_failed'
}
const imageDecryptInFlight = new Map<string, Promise<SharedImageDecryptResult>>()
const senderAvatarCache = createBoundedCache<{ avatarUrl?: string; displayName?: string }>({
  maxEntries: SENDER_AVATAR_CACHE_MAX_ENTRIES
})
const senderAvatarLoading = new Map<string, Promise<{ avatarUrl?: string; displayName?: string } | null>>()

function extractImageOriginSourceMd5(rawContent?: string, imageMd5?: string): string | undefined {
  if (!rawContent) return undefined
  const match = /originsourcemd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(rawContent)
  const value = match?.[1]?.trim().toLowerCase()
  if (!value) return undefined
  const displayMd5 = String(imageMd5 || '').trim().toLowerCase()
  return displayMd5 && value === displayMd5 ? undefined : value
}

function getSharedImageDecryptTask(
  key: string,
  createTask: () => Promise<SharedImageDecryptResult>
): Promise<SharedImageDecryptResult> {
  const existing = imageDecryptInFlight.get(key)
  if (existing) return existing
  const task = createTask().finally(() => {
    if (imageDecryptInFlight.get(key) === task) {
      imageDecryptInFlight.delete(key)
    }
  })
  imageDecryptInFlight.set(key, task)
  return task
}

const buildVoiceCacheIdentity = (
  sessionId: string,
  message: Pick<Message, 'localId' | 'createTime' | 'serverId' | 'serverIdRaw'>
): string => {
  const normalizedSessionId = String(sessionId || '').trim()
  const localId = Math.max(0, Math.floor(Number(message?.localId || 0)))
  const createTime = Math.max(0, Math.floor(Number(message?.createTime || 0)))
  const serverIdRaw = String(message?.serverIdRaw ?? message?.serverId ?? '').trim()
  const serverId = /^\d+$/.test(serverIdRaw)
    ? serverIdRaw.replace(/^0+(?=\d)/, '')
    : String(Math.max(0, Math.floor(Number(serverIdRaw || 0))))
  return `${normalizedSessionId}:${localId}:${createTime}:${serverId || '0'}`
}

// 引用消息中的动画表情组件
function QuotedEmoji({ cdnUrl, md5 }: { cdnUrl: string; md5?: string }) {
  const cacheKey = md5 || cdnUrl
  const [localPath, setLocalPath] = useState<string | undefined>(() => {
    const cached = emojiDataUrlCache.get(cacheKey)
    return cached ? toRenderableImageSrc(cached) : undefined
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (localPath || loading || error) return
    setLoading(true)
    window.electronAPI.chat.downloadEmoji(cdnUrl, md5).then((result: { success: boolean; localPath?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setLocalPath(toRenderableImageSrc(result.localPath))
      } else {
        setError(true)
      }
    }).catch(() => setError(true)).finally(() => setLoading(false))
  }, [cdnUrl, md5, cacheKey, localPath, loading, error])

  if (error || (!loading && !localPath)) return <span className="quoted-type-label">[动画表情]</span>
  if (loading) return <span className="quoted-type-label">[动画表情]</span>
  return <img src={localPath} alt="动画表情" className="quoted-emoji-image" loading="lazy" decoding="async" />
}

// 消息气泡组件
function MessageBubble({
  message,
  messageKey,
  session,
  showTime,
  myAvatarUrl,
  myWxid,
  isGroupChat,
  quoteLayout,
  autoTranscribeVoiceEnabled,
  onRequireModelDownload,
  onContextMenu,
  onJumpToQuotedMessage,
  isSelectionMode,
  isSelected,
  onToggleSelection
}: {
  message: Message;
  messageKey: string;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  myWxid?: string;
  isGroupChat?: boolean;
  quoteLayout: configService.QuoteLayout;
  autoTranscribeVoiceEnabled?: boolean;
  onRequireModelDownload?: (sessionId: string, messageId: string) => void;
  onContextMenu?: (e: React.MouseEvent, message: Message) => void;
  onJumpToQuotedMessage?: (target: QuotedMessageJumpTarget) => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (messageKey: string, isShiftKey?: boolean) => void;
}) {
  const isSystem = isSystemMessage(message.localType)
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isCard = message.localType === 42
  const isCall = message.localType === 50
  const isType49 = message.localType === 49
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [quotedSenderName, setQuotedSenderName] = useState<string | undefined>(undefined)
  const [solitaireExpanded, setSolitaireExpanded] = useState(false)
  const senderProfileRequestSeqRef = useRef(0)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)

  // 缓存相关的 state 必须在所有 Hooks 之前声明
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => toRenderableImageSrc(emojiDataUrlCache.get(cacheKey) || message.emojiLocalPath)
  )
  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
  const resolvedImageOriginSourceMd5 =
    message.imageOriginSourceMd5 ||
    extractImageOriginSourceMd5(message.rawContent, message.imageMd5)
  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(
    () => toRenderableImageSrc(imageDataUrlCache.get(imageCacheKey))
  )
  const voiceIdentityKey = buildVoiceCacheIdentity(session.username, message)
  const voiceCacheKey = `voice:${voiceIdentityKey}`
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | undefined>(
    () => voiceDataUrlCache.get(voiceCacheKey)
  )
  const voiceTranscriptCacheKey = `voice-transcript:${voiceIdentityKey}`
  const [voiceTranscript, setVoiceTranscript] = useState<string | undefined>(
    () => voiceTranscriptCache.get(voiceTranscriptCacheKey)
  )

  // State variables...
  const [imageError, setImageError] = useState(false)
  const [imageErrorReason, setImageErrorReason] = useState<string | undefined>(undefined)
  const [imageFailureKind, setImageFailureKind] = useState<'not_found' | 'decrypt_failed' | undefined>(undefined)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageStageLockHeight, setImageStageLockHeight] = useState<number | null>(null)
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const imageElementRef = useRef<HTMLImageElement | null>(null)
  const emojiContainerRef = useRef<HTMLDivElement>(null)
  const imageResizeBaselineRef = useRef<number | null>(null)
  const emojiResizeBaselineRef = useRef<number | null>(null)
  const imageObservedHeightRef = useRef<number | null>(null)
  const emojiObservedHeightRef = useRef<number | null>(null)
  const imageAutoDecryptTriggered = useRef(false)
  const imageAutoHdTriggered = useRef<string | null>(null)
  const [imageInView, setImageInView] = useState(false)
  const imageForceHdAttempted = useRef<string | null>(null)
  const imageForceHdPending = useRef(false)
  const imageDecryptPendingRef = useRef(false)
  const [imageLiveVideoPath, setImageLiveVideoPath] = useState<string | undefined>(undefined)
  const [voiceError, setVoiceError] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [isVoicePlaying, setIsVoicePlaying] = useState(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceTranscriptLoading, setVoiceTranscriptLoading] = useState(false)
  const [voiceTranscriptError, setVoiceTranscriptError] = useState(false)
  const voiceTranscriptRequestedRef = useRef(false)
  const [voiceCurrentTime, setVoiceCurrentTime] = useState(0)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const [voiceWaveformRequested, setVoiceWaveformRequested] = useState(false)
  const voiceAutoDecryptTriggered = useRef(false)
  const pendingScrollerDeltaRef = useRef(0)
  const pendingScrollerDeltaRafRef = useRef<number | null>(null)


  const [systemAlert, setSystemAlert] = useState<{
    title: string;
    message: React.ReactNode;
  } | null>(null)

  // 转账消息双方名称
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)

  // 视频相关状态
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoInfo, setVideoInfo] = useState<{ videoUrl?: string; coverUrl?: string; thumbUrl?: string; exists: boolean } | null>(null)
  const videoContainerRef = useRef<HTMLElement>(null)
  const [isVideoVisible, setIsVideoVisible] = useState(false)
  const [videoMd5, setVideoMd5] = useState<string | null>(null)
  const imageStageLockStyle = useMemo<React.CSSProperties | undefined>(() => (
    imageStageLockHeight && imageStageLockHeight > 0
      ? { height: `${Math.round(imageStageLockHeight)}px` }
      : undefined
  ), [imageStageLockHeight])

  // 解析视频 MD5
  useEffect(() => {
    if (!isVideo) return





    // 优先使用数据库中的 videoMd5
    if (message.videoMd5) {

      setVideoMd5(message.videoMd5)
      return
    }

    // 尝试从多个可能的字段获取原始内容
    const contentToUse = message.content || (message as any).rawContent || message.parsedContent
    if (contentToUse) {

      window.electronAPI.video.parseVideoMd5(contentToUse).then((result: { success: boolean; md5?: string; error?: string }) => {

        if (result && result.success && result.md5) {

          setVideoMd5(result.md5)
        } else {
          console.error('[Video Debug] Failed to parse MD5:', result)
        }
      }).catch((err: unknown) => {
        console.error('[Video Debug] Parse error:', err)
      })
    }
  }, [isVideo, message.videoMd5, message.content, message.parsedContent])

  const formatTime = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间'
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const detectImageMimeFromBase64 = useCallback((base64: string): string => {
    try {
      const head = window.atob(base64.slice(0, 48))
      const bytes = new Uint8Array(head.length)
      for (let i = 0; i < head.length; i++) {
        bytes[i] = head.charCodeAt(i)
      }
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp'
      }
    } catch { }
    return 'image/jpeg'
  }, [])

  const getImageObserverRoot = useCallback((): Element | null => {
    return imageContainerRef.current?.closest('.message-list') ?? null
  }, [])

  const stabilizeScrollerByDelta = useCallback((host: HTMLElement | null, delta: number) => {
    if (!host) return
    if (!Number.isFinite(delta) || Math.abs(delta) < 1.5) return
    const scroller = host.closest('.message-list') as HTMLDivElement | null
    if (!scroller) return

    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight)
    if (distanceFromBottom <= 96) return

    const scrollerRect = scroller.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const hostTopInScroller = hostRect.top - scrollerRect.top + scroller.scrollTop
    const viewportBottom = scroller.scrollTop + scroller.clientHeight
    if (hostTopInScroller > viewportBottom + 24) return

    pendingScrollerDeltaRef.current += delta
    if (pendingScrollerDeltaRafRef.current !== null) return
    pendingScrollerDeltaRafRef.current = window.requestAnimationFrame(() => {
      pendingScrollerDeltaRafRef.current = null
      const applyDelta = pendingScrollerDeltaRef.current
      pendingScrollerDeltaRef.current = 0
      if (!Number.isFinite(applyDelta) || Math.abs(applyDelta) < 1.5) return
      const nextScroller = host.closest('.message-list') as HTMLDivElement | null
      if (!nextScroller) return
      nextScroller.scrollTop += applyDelta
    })
  }, [])

  const bindResizeObserverForHost = useCallback((
    host: HTMLElement | null,
    observedHeightRef: React.MutableRefObject<number | null>,
    pendingBaselineRef: React.MutableRefObject<number | null>
  ) => {
    if (!host) return

    const initialHeight = host.getBoundingClientRect().height
    observedHeightRef.current = Number.isFinite(initialHeight) && initialHeight > 0 ? initialHeight : null
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const nextHeight = host.getBoundingClientRect().height
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
        observedHeightRef.current = null
        return
      }
      const previousHeight = observedHeightRef.current
      observedHeightRef.current = nextHeight
      if (!Number.isFinite(previousHeight) || (previousHeight as number) <= 0) return
      if (pendingBaselineRef.current !== null) return
      stabilizeScrollerByDelta(host, nextHeight - (previousHeight as number))
    })

    observer.observe(host)
    return () => {
      observer.disconnect()
    }
  }, [stabilizeScrollerByDelta])

  const captureResizeBaseline = useCallback(
    (host: HTMLElement | null, baselineRef: React.MutableRefObject<number | null>) => {
      if (!host) return
      const height = host.getBoundingClientRect().height
      if (!Number.isFinite(height) || height <= 0) return
      baselineRef.current = height
    },
    []
  )

  const stabilizeScrollAfterResize = useCallback(
    (host: HTMLElement | null, baselineRef: React.MutableRefObject<number | null>) => {
      if (!host) return
      const baseline = baselineRef.current
      baselineRef.current = null
      if (!Number.isFinite(baseline) || (baseline as number) <= 0) return

      requestAnimationFrame(() => {
        const nextHeight = host.getBoundingClientRect().height
        stabilizeScrollerByDelta(host, nextHeight - (baseline as number))
      })
    },
    [stabilizeScrollerByDelta]
  )

  const captureImageResizeBaseline = useCallback(() => {
    captureResizeBaseline(imageContainerRef.current, imageResizeBaselineRef)
  }, [captureResizeBaseline])

  const lockImageStageHeight = useCallback(() => {
    const host = imageContainerRef.current
    if (!host) return
    const height = host.getBoundingClientRect().height
    if (!Number.isFinite(height) || height <= 0) return
    setImageStageLockHeight(Math.round(height))
  }, [])

  const captureEmojiResizeBaseline = useCallback(() => {
    captureResizeBaseline(emojiContainerRef.current, emojiResizeBaselineRef)
  }, [captureResizeBaseline])

  const stabilizeImageScrollAfterResize = useCallback(() => {
    stabilizeScrollAfterResize(imageContainerRef.current, imageResizeBaselineRef)
  }, [stabilizeScrollAfterResize])

  const releaseImageStageLock = useCallback(() => {
    window.requestAnimationFrame(() => {
      setImageStageLockHeight(null)
    })
  }, [])

  const stabilizeEmojiScrollAfterResize = useCallback(() => {
    stabilizeScrollAfterResize(emojiContainerRef.current, emojiResizeBaselineRef)
  }, [stabilizeScrollAfterResize])

  useEffect(() => {
    if (!isImage) return
    return bindResizeObserverForHost(imageContainerRef.current, imageObservedHeightRef, imageResizeBaselineRef)
  }, [isImage, bindResizeObserverForHost])

  useEffect(() => {
    if (!isEmoji) return
    return bindResizeObserverForHost(emojiContainerRef.current, emojiObservedHeightRef, emojiResizeBaselineRef)
  }, [isEmoji, bindResizeObserverForHost])

  // 下载表情包
  const downloadEmoji = () => {
    if (!message.emojiCdnUrl || emojiLoading) return

    // 先检查缓存
    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      captureEmojiResizeBaseline()
      setEmojiLocalPath(toRenderableImageSrc(cached))
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)
    window.electronAPI.chat.downloadEmoji(message.emojiCdnUrl, message.emojiMd5).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        captureEmojiResizeBaseline()
        setEmojiLocalPath(toRenderableImageSrc(result.localPath))
      } else {
        setEmojiError(true)
      }
    }).catch(() => {
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }

  // 群聊中获取发送者信息 (如果自己发的没头像，也尝试拉取)
  useEffect(() => {
    const sender = String(message.senderUsername || '').trim()
    const cached = sender ? senderAvatarCache.get(sender) : undefined
    setSenderAvatarUrl(cached?.avatarUrl || message.senderAvatarUrl || undefined)
    setSenderName(cached?.displayName || message.senderDisplayName || undefined)

    if (!sender || !(isGroupChat || (isSent && !myAvatarUrl))) return

    const requestSeq = senderProfileRequestSeqRef.current + 1
    senderProfileRequestSeqRef.current = requestSeq
    let cancelled = false
    const applyProfile = (result: { avatarUrl?: string; displayName?: string } | null) => {
      if (!result || cancelled) return
      if (requestSeq !== senderProfileRequestSeqRef.current) return
      if (result.avatarUrl) setSenderAvatarUrl(result.avatarUrl)
      if (result.displayName) setSenderName(result.displayName)
    }

    if (cached) {
      applyProfile(cached)
      return () => {
        cancelled = true
      }
    }

    const pending = senderAvatarLoading.get(sender)
    if (pending) {
      pending.then(applyProfile).catch(() => { })
      return () => {
        cancelled = true
      }
    }

    const request = window.electronAPI.chat.getContactAvatar(sender)
    senderAvatarLoading.set(sender, request)
    request.then((result: { avatarUrl?: string; displayName?: string } | null) => {
      if (result) {
        senderAvatarCache.set(sender, result)
      }
      applyProfile(result)
    }).catch(() => { }).finally(() => {
      if (senderAvatarLoading.get(sender) === request) {
        senderAvatarLoading.delete(sender)
      }
    })

    return () => {
      cancelled = true
    }
  }, [isGroupChat, isSent, message.senderAvatarUrl, message.senderDisplayName, message.senderUsername, myAvatarUrl])

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    const payerWxid = (message as any).transferPayerUsername
    const receiverWxid = (message as any).transferReceiverUsername
    if (!payerWxid && !receiverWxid) return
    // 仅对转账消息类型处理
    if (message.localType !== 49 && message.localType !== 8589934592049) return

    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      payerWxid || '',
      receiverWxid || ''
    ).then((result: { payerName: string; receiverName: string }) => {
      if (result) {
        setTransferPayerName(result.payerName)
        setTransferReceiverName(result.receiverName)
      }
    }).catch(() => { })
  }, [(message as any).transferPayerUsername, (message as any).transferReceiverUsername, session.username])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    // 后端已从本地缓存找到文件（转发表情包无 CDN URL 的情况）
    if (isEmoji && message.emojiLocalPath) {
      captureEmojiResizeBaseline()
      setEmojiLocalPath(toRenderableImageSrc(message.emojiLocalPath))
      return
    }
    if (isEmoji && message.emojiCdnUrl && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiLocalPath, emojiLocalPath, emojiLoading, emojiError, captureEmojiResizeBaseline])

  const requestImageDecrypt = useCallback(async (forceUpdate = false, silent = false): Promise<SharedImageDecryptResult> => {
    if (!isImage) return { success: false }
    if (imageDecryptPendingRef.current) return { success: false }
    imageDecryptPendingRef.current = true
    const resolvedOriginSourceMd5 = resolvedImageOriginSourceMd5
    if (!silent) {
      setImageLoading(true)
      setImageError(false)
    }
    try {
      if (message.imageMd5 || resolvedOriginSourceMd5 || message.imageDatName) {
        const sharedDecryptKey = `${session.username}:${imageCacheKey}:${forceUpdate ? 'force' : 'normal'}`
        const result = await getSharedImageDecryptTask(sharedDecryptKey, async () => {
          return await window.electronAPI.image.decrypt({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageOriginSourceMd5: resolvedOriginSourceMd5 || undefined,
            imageDatName: message.imageDatName,
            createTime: message.createTime,
            force: forceUpdate,
            preferFilePath: true,
            hardlinkOnly: true
          }) as SharedImageDecryptResult
        })
        if (result.success && result.localPath) {
          const renderPath = toRenderableImageSrc(result.localPath)
          if (!renderPath) {
            if (!silent) {
              setImageError(true)
              setImageErrorReason('路径无效')
              setImageFailureKind('decrypt_failed')
            }
            return { success: false }
          }
          imageDataUrlCache.set(imageCacheKey, renderPath)
          if (imageLocalPath !== renderPath) {
            captureImageResizeBaseline()
            lockImageStageHeight()
          }
          setImageLocalPath(renderPath)
          setImageHasUpdate(false)
          if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
          return { ...result, localPath: renderPath }
        } else if (!silent && result.error) {
          setImageError(true)
          setImageErrorReason(result.error)
          setImageFailureKind(result.failureKind)
        }
      }

      const fallback = await window.electronAPI.chat.getImageData(session.username, String(message.localId))
      if (fallback.success && fallback.data) {
        const mime = detectImageMimeFromBase64(fallback.data)
        const dataUrl = `data:${mime};base64,${fallback.data}`
        imageDataUrlCache.set(imageCacheKey, dataUrl)
        if (imageLocalPath !== dataUrl) {
          captureImageResizeBaseline()
          lockImageStageHeight()
        }
        setImageLocalPath(dataUrl)
        setImageHasUpdate(false)
        return { success: true, localPath: dataUrl }
      }
      if (!silent) {
        setImageError(true)
        setImageErrorReason('图片数据获取失败')
        setImageFailureKind('not_found')
      }
    } catch (e) {
      if (!silent) {
        setImageError(true)
        setImageErrorReason(e instanceof Error ? e.message : '解密异常')
        setImageFailureKind('decrypt_failed')
      }
    } finally {
      if (!silent) setImageLoading(false)
      imageDecryptPendingRef.current = false
    }
    return { success: false }
  }, [isImage, message.imageMd5, resolvedImageOriginSourceMd5, message.imageDatName, message.createTime, message.localId, session.username, imageCacheKey, detectImageMimeFromBase64, imageLocalPath, captureImageResizeBaseline, lockImageStageHeight])

  const triggerForceHd = useCallback(async (): Promise<void> => {
    if (!message.imageMd5 && !resolvedImageOriginSourceMd5 && !message.imageDatName) return
    if (imageForceHdAttempted.current === imageCacheKey) return
    if (imageForceHdPending.current) return
    imageForceHdAttempted.current = imageCacheKey
    imageForceHdPending.current = true
    await requestImageDecrypt(true, true).finally(() => {
      imageForceHdPending.current = false
    })
  }, [imageCacheKey, message.imageDatName, message.imageMd5, resolvedImageOriginSourceMd5, requestImageDecrypt])

  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    console.info('[UI] image decrypt click (force HD)', {
      sessionId: session.username,
      imageMd5: message.imageMd5,
      imageOriginSourceMd5: resolvedImageOriginSourceMd5,
      imageDatName: message.imageDatName,
      localId: message.localId
    })
    void requestImageDecrypt(true)
  }, [message.imageDatName, message.imageMd5, resolvedImageOriginSourceMd5, message.localId, requestImageDecrypt, session.username])

  const handleOpenImageViewer = useCallback(async () => {
    if (!imageLocalPath) return

    let finalImagePath = imageLocalPath
    let finalLiveVideoPath = imageLiveVideoPath || undefined

    // Every explicit preview click re-runs the forced HD search/decrypt path so
    // users don't need to re-enter the session after WeChat materializes a new original image.
    if (message.imageMd5 || resolvedImageOriginSourceMd5 || message.imageDatName) {
      try {
        const upgraded = await requestImageDecrypt(true, true)
        if (upgraded?.success && upgraded.localPath) {
          finalImagePath = upgraded.localPath
          finalLiveVideoPath = upgraded.liveVideoPath || finalLiveVideoPath
        }
      } catch { }
    }

    // One more resolve helps when background/batch decrypt has produced a clearer image or live video
    // but local component state hasn't caught up yet.
    if (message.imageMd5 || resolvedImageOriginSourceMd5 || message.imageDatName) {
      try {
        const resolved = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageOriginSourceMd5: resolvedImageOriginSourceMd5 || undefined,
          imageDatName: message.imageDatName,
          createTime: message.createTime,
          preferFilePath: true,
          hardlinkOnly: true
        })
        if (resolved?.success && resolved.localPath) {
          const renderPath = toRenderableImageSrc(resolved.localPath)
          if (!renderPath) return
          finalImagePath = renderPath
          finalLiveVideoPath = resolved.liveVideoPath || finalLiveVideoPath
          imageDataUrlCache.set(imageCacheKey, renderPath)
          if (imageLocalPath !== renderPath) {
            captureImageResizeBaseline()
            lockImageStageHeight()
          }
          setImageLocalPath(renderPath)
          if (resolved.liveVideoPath) setImageLiveVideoPath(resolved.liveVideoPath)
          setImageHasUpdate(Boolean(resolved.hasUpdate))
        }
      } catch { }
    }

    void window.electronAPI.window.openImageViewerWindow(toRenderableImageSrc(finalImagePath) || finalImagePath, finalLiveVideoPath)
  }, [
    imageLiveVideoPath,
    imageLocalPath,
    imageCacheKey,
    captureImageResizeBaseline,
    lockImageStageHeight,
    message.imageDatName,
    message.imageMd5,
    message.createTime,
    requestImageDecrypt,
    session.username
  ])

  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
      if (pendingScrollerDeltaRafRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollerDeltaRafRef.current)
        pendingScrollerDeltaRafRef.current = null
      }
      pendingScrollerDeltaRef.current = 0
    }
  }, [])

  useEffect(() => {
    if (!isImage) return
    if (!imageLocalPath) {
      setImageLoaded(false)
      return
    }

    // 某些 file:// 缓存图在 src 切换时可能不会稳定触发 onLoad，
    // 这里用 complete/naturalWidth 做一次兜底，避免图片进入 pending 隐身态。
    const img = imageElementRef.current
    if (img && img.complete && img.naturalWidth > 0) {
      setImageLoaded(true)
    }
  }, [isImage, imageLocalPath])

  useEffect(() => {
    if (imageLoading) return
    if (!imageError && imageLocalPath) return
    setImageStageLockHeight(null)
  }, [imageError, imageLoading, imageLocalPath])

  useEffect(() => {
    if (!isImage || imageLoading || !imageInView) return
    if (!message.imageMd5 && !resolvedImageOriginSourceMd5 && !message.imageDatName) return
    if (imageUpdateCheckedRef.current === imageCacheKey) return
    imageUpdateCheckedRef.current = imageCacheKey
    let cancelled = false
    window.electronAPI.image.resolveCache({
      sessionId: session.username,
      imageMd5: message.imageMd5 || undefined,
      imageOriginSourceMd5: resolvedImageOriginSourceMd5 || undefined,
      imageDatName: message.imageDatName,
      createTime: message.createTime,
      preferFilePath: true,
      hardlinkOnly: true,
      allowCacheIndex: false
    }).then((result: { success: boolean; localPath?: string; hasUpdate?: boolean; liveVideoPath?: string; error?: string }) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        const renderPath = toRenderableImageSrc(result.localPath)
        if (!renderPath) return
        imageDataUrlCache.set(imageCacheKey, renderPath)
        if (!imageLocalPath || imageLocalPath !== renderPath) {
          captureImageResizeBaseline()
          lockImageStageHeight()
          setImageLocalPath(renderPath)
          setImageError(false)
        }
        if (result.liveVideoPath) setImageLiveVideoPath(result.liveVideoPath)
        setImageHasUpdate(Boolean(result.hasUpdate))
      }
    }).catch(() => { })
    return () => {
      cancelled = true
    }
  }, [isImage, imageInView, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, message.createTime, imageCacheKey, session.username, captureImageResizeBaseline, lockImageStageHeight])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, message.imageDatName, message.imageMd5])

  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        const renderPath = toRenderableImageSrc(payload.localPath)
        if (!renderPath) return
        const cachedPath = imageDataUrlCache.get(imageCacheKey)
        if (cachedPath !== renderPath) {
          imageDataUrlCache.set(imageCacheKey, renderPath)
        }
        if (imageLocalPath !== renderPath) {
          captureImageResizeBaseline()
          lockImageStageHeight()
        }
        setImageLocalPath((prev) => (prev === renderPath ? prev : renderPath))
        setImageError(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, imageCacheKey, imageLocalPath, message.imageDatName, message.imageMd5, captureImageResizeBaseline, lockImageStageHeight])

  // 图片进入视野前自动解密（懒加载）
  useEffect(() => {
    if (!isImage) return
    if (imageLocalPath) return // 已有图片，不需要解密
    if (!message.imageMd5 && !message.imageDatName) return

    const container = imageContainerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        // rootMargin 设置为 200px，提前感知即将进入视野的图片
        setImageInView(entry.isIntersecting)
      },
      { root: getImageObserverRoot(), rootMargin: '200px', threshold: 0 }
    )

    observer.observe(container)
    return () => observer.disconnect()
  }, [getImageObserverRoot, isImage])

  // 进入视野后自动触发一次普通解密
  useEffect(() => {
    if (!isImage || !imageInView) return
    if (imageLocalPath || imageLoading) return
    if (!message.imageMd5 && !resolvedImageOriginSourceMd5 && !message.imageDatName) return
    if (imageAutoDecryptTriggered.current) return
    imageAutoDecryptTriggered.current = true
    void enqueueAutoMediaTask(async () => requestImageDecrypt()).catch(() => { })
  }, [isImage, imageInView, imageLocalPath, imageLoading, message.imageMd5, message.imageDatName, requestImageDecrypt])

  useEffect(() => {
    if (!isImage || !imageHasUpdate || !imageInView) return
    if (imageAutoHdTriggered.current === imageCacheKey) return
    imageAutoHdTriggered.current = imageCacheKey
    void enqueueAutoMediaTask(async () => {
      await triggerForceHd()
    }).catch(() => { })
  }, [isImage, imageHasUpdate, imageInView, imageCacheKey, triggerForceHd])


  useEffect(() => {
    if (!isVoice) return
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio()
    }
    const audio = voiceAudioRef.current
    if (!audio) return
    const handlePlay = () => setIsVoicePlaying(true)
    const handlePause = () => setIsVoicePlaying(false)
    const handleEnded = () => {
      setIsVoicePlaying(false)
      setVoiceCurrentTime(0)
      globalVoiceManager.stop(audio)
    }
    const handleTimeUpdate = () => {
      setVoiceCurrentTime(audio.currentTime)
    }
    const handleLoadedMetadata = () => {
      setVoiceDuration(audio.duration)
    }
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      audio.pause()
      globalVoiceManager.stop(audio)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [isVoice])

  // 生成波形数据
  useEffect(() => {
    if (!voiceDataUrl || !voiceWaveformRequested) {
      setVoiceWaveform([])
      return
    }

    let cancelled = false
    let audioCtx: AudioContext | null = null

    const generateWaveform = async () => {
      try {
        // 从 data:audio/wav;base64,... 提取 base64
        const base64 = voiceDataUrl.split(',')[1]
        if (!base64) return
        const binaryString = window.atob(base64)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }

        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer)
        if (cancelled) return
        const rawData = audioBuffer.getChannelData(0) // 获取单声道数据
        const samples = 24 // 波形柱子数量（降低解码计算成本）
        const blockSize = Math.floor(rawData.length / samples)
        if (blockSize <= 0) return
        const filteredData: number[] = []

        for (let i = 0; i < samples; i++) {
          const blockStart = blockSize * i
          let sum = 0
          for (let j = 0; j < blockSize; j++) {
            sum = sum + Math.abs(rawData[blockStart + j])
          }
          filteredData.push(sum / blockSize)
        }

        // 归一化
        const peak = Math.max(...filteredData)
        if (!Number.isFinite(peak) || peak <= 0) return
        const multiplier = Math.pow(peak, -1)
        const normalizedData = filteredData.map(n => n * multiplier)
        if (!cancelled) {
          setVoiceWaveform(normalizedData)
        }
      } catch (e) {
        console.error('Failed to generate waveform:', e)
        // 降级：生成随机但平滑的波形
        if (!cancelled) {
          setVoiceWaveform(Array.from({ length: 24 }, () => 0.2 + Math.random() * 0.8))
        }
      } finally {
        if (audioCtx) {
          void audioCtx.close().catch(() => { })
        }
      }
    }

    scheduleWhenIdle(() => {
      if (cancelled) return
      void generateWaveform()
    }, { timeout: 900, fallbackDelay: 80 })

    return () => {
      cancelled = true
      if (audioCtx) {
        void audioCtx.close().catch(() => { })
        audioCtx = null
      }
    }
  }, [voiceDataUrl, voiceWaveformRequested])

  // 消息加载时自动检测语音缓存
  useEffect(() => {
    if (!isVoice || voiceDataUrl) return
    window.electronAPI.chat.resolveVoiceCache(session.username, String(message.localId))
      .then((result: { success: boolean; hasCache: boolean; data?: string; error?: string }) => {
        if (result.success && result.hasCache && result.data) {
          const url = `data:audio/wav;base64,${result.data}`
          voiceDataUrlCache.set(voiceCacheKey, url)
          setVoiceDataUrl(url)
        }
      })
  }, [isVoice, message.localId, session.username, voiceCacheKey, voiceDataUrl])

  // 监听流式转写结果
  useEffect(() => {
    if (!isVoice) return
    const removeListener = window.electronAPI.chat.onVoiceTranscriptPartial?.((payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => {
      const sameSession = !payload.sessionId || payload.sessionId === session.username
      const sameMsgId = payload.msgId === String(message.localId)
      const sameCreateTime = payload.createTime == null || Number(payload.createTime) === Number(message.createTime || 0)
      if (!sameSession || !sameMsgId || !sameCreateTime) return
      setVoiceTranscript(payload.text)
      voiceTranscriptCache.set(voiceTranscriptCacheKey, payload.text)
    })
    return () => removeListener?.()
  }, [isVoice, message.createTime, message.localId, session.username, voiceTranscriptCacheKey])

  const requestVoiceTranscript = useCallback(async () => {
    if (voiceTranscriptLoading || voiceTranscriptRequestedRef.current) return

    // 检查 whisper API 是否可用
    if (!window.electronAPI?.whisper?.getModelStatus) {
      console.warn('[ChatPage] whisper API 不可用')
      setVoiceTranscriptError(true)
      return
    }

    voiceTranscriptRequestedRef.current = true
    setVoiceTranscriptLoading(true)
    setVoiceTranscriptError(false)
    try {
      // 检查模型状态
      const modelStatus = await window.electronAPI.whisper.getModelStatus()
      if (!modelStatus?.exists) {
        const error: any = new Error('MODEL_NOT_DOWNLOADED')
        error.requiresDownload = true
        error.sessionId = session.username
        error.messageId = String(message.localId)
        throw error
      }

      const result = await window.electronAPI.chat.getVoiceTranscript(
          session.username,
          String(message.localId),
          message.createTime
      )

      if (result.success) {
        const transcriptText = (result.transcript || '').trim()
        voiceTranscriptCache.set(voiceTranscriptCacheKey, transcriptText)
        setVoiceTranscript(transcriptText)
      } else {
        if (result.error === 'SEGFAULT_ERROR') {
          console.warn('[ChatPage] 捕获到语音引擎底层段错误');

          setSystemAlert({
            title: '引擎崩溃提示',
            message: (
                <>
                  语音识别引擎发生底层崩溃 (Segmentation Fault)。<br /><br />
                  如果您使用的是 Linux 等自定义程度较高的系统，请检查 <code>sherpa-onnx</code> 的相关系统动态链接库 (如 glibc 等) 是否兼容。
                </>
            )
          });

        }

        setVoiceTranscriptError(true)
        voiceTranscriptRequestedRef.current = false
      }
    } catch (error: any) {
      // 检查是否是模型未下载错误
      if (error?.requiresDownload) {
        // 模型未下载，触发下载弹窗
        onRequireModelDownload?.(error.sessionId, error.messageId)
        // 不要重置 voiceTranscriptRequestedRef，避免重复触发
        setVoiceTranscriptLoading(false)
        return
      }
      setVoiceTranscriptError(true)
      voiceTranscriptRequestedRef.current = false
    } finally {
      setVoiceTranscriptLoading(false)
    }
  }, [message.createTime, message.localId, session.username, voiceTranscriptCacheKey, voiceTranscriptLoading, onRequireModelDownload])

  // 监听模型下载完成事件
  useEffect(() => {
    if (!isVoice) return

    const handleModelDownloaded = (event: CustomEvent) => {
      if (
        event.detail?.messageId === String(message.localId) &&
        (!event.detail?.sessionId || event.detail?.sessionId === session.username)
      ) {
        // 重置状态，允许重新尝试转写
        voiceTranscriptRequestedRef.current = false
        setVoiceTranscriptError(false)
        // 立即尝试转写
        void requestVoiceTranscript()
      }
    }

    window.addEventListener('model-downloaded', handleModelDownloaded as EventListener)
    return () => {
      window.removeEventListener('model-downloaded', handleModelDownloaded as EventListener)
    }
  }, [isVoice, message.localId, requestVoiceTranscript, session.username])

  // 视频懒加载
  const videoAutoLoadTriggered = useRef(false)
  const [videoClicked, setVideoClicked] = useState(false)

  useEffect(() => {
    if (!isVideo || !videoContainerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVideoVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)

    return () => observer.disconnect()
  }, [isVideo])

  // 视频加载中状态引用，避免依赖问题
  const videoLoadingRef = useRef(false)

  // 加载视频信息（添加重试机制）
  const requestVideoInfo = useCallback(async () => {
    if (!videoMd5 || videoLoadingRef.current) return

    videoLoadingRef.current = true
    setVideoLoading(true)
    try {
      const result = await window.electronAPI.video.getVideoInfo(videoMd5)
      if (result && result.success && result.exists) {
        setVideoInfo({
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl
        })
      } else {
        setVideoInfo({ exists: false })
      }
    } catch (err) {
      setVideoInfo({ exists: false })
    } finally {
      videoLoadingRef.current = false
      setVideoLoading(false)
    }
  }, [videoMd5])

  // 视频进入视野时自动加载
  useEffect(() => {
    if (!isVideo || !isVideoVisible) return
    if (videoInfo?.exists) return // 已成功加载，不需要重试
    if (videoAutoLoadTriggered.current) return

    videoAutoLoadTriggered.current = true
    void enqueueAutoMediaTask(async () => requestVideoInfo()).catch(() => {
      videoAutoLoadTriggered.current = false
    })
  }, [isVideo, isVideoVisible, videoInfo, requestVideoInfo])

  useEffect(() => {
    if (!autoTranscribeVoiceEnabled) return
    if (!isVoice) return
    if (!voiceDataUrl) return
    if (voiceTranscriptError) return
    if (voiceTranscriptLoading || voiceTranscript !== undefined || voiceTranscriptRequestedRef.current) return
    void requestVoiceTranscript()
  }, [autoTranscribeVoiceEnabled, isVoice, voiceDataUrl, voiceTranscript, voiceTranscriptError, voiceTranscriptLoading, requestVoiceTranscript])

  // 去除企业微信 ID 前缀
  const cleanMessageContent = useCallback((content: string) => {
    if (!content) return ''
    return content.replace(/^[a-zA-Z0-9]+@openim:\n?/, '')
  }, [])

  // 解析混合文本和表情
  const renderTextWithEmoji = useCallback((text: string) => {
    if (!text) return text
    const parts = text.split(/\[(.*?)\]/g)
    return parts.map((part, index) => {
      // 奇数索引是捕获组的内容（即括号内的文字）
      if (index % 2 === 1) {
        // @ts-ignore
        const path = getEmojiPath(part as any)
        if (path) {
          // path 例如 'assets/face/微笑.png'，需要添加 base 前缀
          return (
            <img
              key={index}
              src={`${import.meta.env.BASE_URL}${path}`}
              alt={`[${part}]`}
              className="inline-emoji"
              style={{ width: 22, height: 22, verticalAlign: 'bottom', margin: '0 1px' }}
            />
          )
        }
        return `[${part}]`
      }
      return part
    })
  }, [])

  const cleanedParsedContent = useMemo(
    () => cleanMessageContent(message.parsedContent || ''),
    [cleanMessageContent, message.parsedContent]
  )

  const appMsgRawXml = message.rawContent || message.parsedContent || ''
  const appMsgContainsTag = useMemo(
    () => appMsgRawXml.includes('<appmsg') || appMsgRawXml.includes('&lt;appmsg'),
    [appMsgRawXml]
  )
  const appMsgDoc = useMemo(() => {
    if (!appMsgContainsTag) return null
    try {
      const start = appMsgRawXml.indexOf('<msg>')
      const xml = start >= 0 ? appMsgRawXml.slice(start) : appMsgRawXml
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      if (doc.querySelector('parsererror')) return null
      return doc
    } catch {
      return null
    }
  }, [appMsgContainsTag, appMsgRawXml])
  const appMsgTextCache = useMemo(() => new Map<string, string>(), [appMsgDoc])
  const queryAppMsgText = useCallback((selector: string): string => {
    const cached = appMsgTextCache.get(selector)
    if (cached !== undefined) return cached
    const value = appMsgDoc?.querySelector(selector)?.textContent?.trim() || ''
    appMsgTextCache.set(selector, value)
    return value
  }, [appMsgDoc, appMsgTextCache])
  const decodeHtmlEntities = useCallback((text: string): string => {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = text
    return textarea.value
  }, [])

  const queryPreferredQuotedContent = useCallback((): string => {
    if (message.quotedContent) return decodeHtmlEntities(message.quotedContent)
    const candidates = [
      'refermsg > selectedcontent',
      'refermsg > selectedtext',
      'refermsg > selectcontent',
      'refermsg > selecttext',
      'refermsg > quotecontent',
      'refermsg > quotetext',
      'refermsg > partcontent',
      'refermsg > parttext',
      'refermsg > excerpt',
      'refermsg > summary',
      'refermsg > preview',
      'refermsg > content'
    ]
    for (const selector of candidates) {
      const value = queryAppMsgText(selector)
      if (value) return decodeHtmlEntities(value)
    }
    return ''
  }, [message.quotedContent, queryAppMsgText, decodeHtmlEntities])
  const appMsgThumbRawCandidate = useMemo(() => (
    message.linkThumb ||
    message.appMsgThumbUrl ||
    queryAppMsgText('appmsg > thumburl') ||
    queryAppMsgText('appmsg > cdnthumburl') ||
    queryAppMsgText('appmsg > cover') ||
    queryAppMsgText('appmsg > coverurl') ||
    queryAppMsgText('thumburl') ||
    queryAppMsgText('cdnthumburl') ||
    queryAppMsgText('cover') ||
    queryAppMsgText('coverurl') ||
    ''
  ).trim(), [message.linkThumb, message.appMsgThumbUrl, queryAppMsgText])
  const quotedSenderUsername = resolveQuotedSenderUsername(
    queryAppMsgText('refermsg > fromusr'),
    queryAppMsgText('refermsg > chatusr')
  )
  const quotedContent = queryPreferredQuotedContent()
  const quotedSenderFallbackName = useMemo(
    () => resolveQuotedSenderFallbackDisplayName(
      session.username,
      quotedSenderUsername,
      message.quotedSender || queryAppMsgText('refermsg > displayname') || ''
    ),
    [message.quotedSender, queryAppMsgText, quotedSenderUsername, session.username]
  )

  useEffect(() => {
    let cancelled = false
    const nextFallbackName = quotedSenderFallbackName || undefined
    setQuotedSenderName(nextFallbackName)

    if (!quotedContent || !quotedSenderUsername) {
      return () => {
        cancelled = true
      }
    }

    void resolveQuotedSenderDisplayName({
      sessionId: session.username,
      senderUsername: quotedSenderUsername,
      fallbackDisplayName: nextFallbackName,
      isGroupChat,
      myWxid
    }).then((resolvedName) => {
      if (cancelled) return
      setQuotedSenderName(resolvedName || nextFallbackName)
    })

    return () => {
      cancelled = true
    }
  }, [
    quotedContent,
    quotedSenderFallbackName,
    quotedSenderUsername,
    session.username,
    isGroupChat,
    myWxid
  ])

  // quoteLayout config removed - Ambient Reply uses a single fixed layout

  const locationMessageMeta = useMemo(() => {
    if (message.localType !== 48) return null
    const raw = message.rawContent || ''
    const poiname = raw.match(/poiname="([^"]*)"/)?.[1] || message.locationPoiname || '位置'
    const label = raw.match(/label="([^"]*)"/)?.[1] || message.locationLabel || ''
    const lat = parseFloat(raw.match(/x="([^"]*)"/)?.[1] || String(message.locationLat || 0))
    const lng = parseFloat(raw.match(/y="([^"]*)"/)?.[1] || String(message.locationLng || 0))
    const zoom = 15
    const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom))
    const latRad = lat * Math.PI / 180
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom))
    const mapTileUrl = (lat && lng)
      ? `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
      : ''
    return { poiname, label, lat, lng, mapTileUrl }
  }, [message.localType, message.rawContent, message.locationPoiname, message.locationLabel, message.locationLat, message.locationLng])

  // 检测是否为链接卡片消息
  const isLinkMessage = String(message.localType) === '21474836529' || appMsgContainsTag
  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：优先使用 myAvatarUrl，缺失则用 senderAvatarUrl (补救)
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const fallbackSenderName = String(message.senderDisplayName || message.senderUsername || '').trim() || undefined
  const resolvedSenderName = senderName || fallbackSenderName
  const resolvedSenderAvatarUrl = senderAvatarUrl || message.senderAvatarUrl
  const avatarUrl = isSent
    ? (myAvatarUrl || resolvedSenderAvatarUrl)
    : (isGroupChat ? resolvedSenderAvatarUrl : session.avatarUrl)

  // 是否有引用消息
  const hasQuote = quotedContent.length > 0
  const displayQuotedSenderName = quotedSenderName || quotedSenderFallbackName
  const quotedJumpTarget = useMemo<QuotedMessageJumpTarget | null>(() => {
    if (!hasQuote) return null

    const quotedServerId = normalizeMessageIdToken(
      queryAppMsgText('refermsg > svrid') ||
      queryAppMsgText('refermsg > msgsvrid') ||
      queryAppMsgText('refermsg > newmsgid') ||
      queryAppMsgText('refermsg > msgid')
    )
    const quotedCreateTime = parsePositiveInteger(
      queryAppMsgText('refermsg > createtime') ||
      queryAppMsgText('refermsg > create_time') ||
      queryAppMsgText('refermsg > createTime')
    )
    const quotedLocalId = parsePositiveInteger(
      queryAppMsgText('refermsg > localid') ||
      queryAppMsgText('refermsg > local_id') ||
      queryAppMsgText('refermsg > localId')
    )
    const normalizedQuotedContent = normalizeQuotedComparableText(quotedContent)

    if (!quotedServerId && !quotedCreateTime && !quotedLocalId && !normalizedQuotedContent) {
      return null
    }

    return {
      sourceMessageKey: messageKey,
      sourceCreateTime: Number(message.createTime || 0),
      sessionId: session.username,
      localId: quotedLocalId,
      serverId: quotedServerId || undefined,
      createTime: quotedCreateTime,
      senderUsername: quotedSenderUsername || undefined,
      content: normalizedQuotedContent || undefined
    }
  }, [hasQuote, message.createTime, messageKey, queryAppMsgText, quotedContent, quotedSenderUsername, session.username])
  const handleQuotedJumpClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isSelectionMode) return
    if (!quotedJumpTarget || !onJumpToQuotedMessage) return
    event.stopPropagation()
    onJumpToQuotedMessage(quotedJumpTarget)
  }, [isSelectionMode, onJumpToQuotedMessage, quotedJumpTarget])
  const handleQuotedJumpKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (isSelectionMode) return
    if (!quotedJumpTarget || !onJumpToQuotedMessage) return
    event.preventDefault()
    event.stopPropagation()
    onJumpToQuotedMessage(quotedJumpTarget)
  }, [isSelectionMode, onJumpToQuotedMessage, quotedJumpTarget])
  const isQuoteBelow = quoteLayout === 'quote-bottom'
  const renderBubbleWithQuote = useCallback((quotedNode: React.ReactNode, messageNode: React.ReactNode) => (
    <div className={`bubble-content ${isQuoteBelow ? 'quote-layout-bottom' : 'quote-layout-top'}`}>
      {isQuoteBelow ? (
        <>
          {messageNode}
          {quotedNode}
        </>
      ) : (
        <>
          {quotedNode}
          {messageNode}
        </>
      )}
    </div>
  ), [isQuoteBelow])

  // Ambient Reply: render reply-anchor + ghost preview
  const renderQuotedMessageBlock = useCallback((contentNode: React.ReactNode) => (
    <div className={`ambient-reply-wrapper ${isQuoteBelow ? 'preview-below' : 'preview-above'}`}>
      {/* Reply anchor - always visible, subtle */}
      <div
        className={`reply-anchor ${quotedJumpTarget ? 'jumpable' : ''}`}
        role={quotedJumpTarget && !isSelectionMode ? 'button' : undefined}
        tabIndex={quotedJumpTarget && !isSelectionMode ? 0 : undefined}
        onClick={handleQuotedJumpClick}
        onKeyDown={handleQuotedJumpKeyDown}
      >
        <svg className="reply-anchor-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 14 4 9 9 4" />
          <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
        </svg>
        {displayQuotedSenderName && <span className="reply-anchor-name">{displayQuotedSenderName}</span>}
        <span className="reply-anchor-sep">&middot;</span>
        <span className="reply-anchor-excerpt">{contentNode}</span>
      </div>
      {/* Ghost preview - appears on hover */}
      <div className="reply-ghost">
        {displayQuotedSenderName && <div className="reply-ghost-sender">{displayQuotedSenderName}</div>}
        <div className="reply-ghost-text">{contentNode}</div>
      </div>
    </div>
  ), [displayQuotedSenderName, handleQuotedJumpClick, handleQuotedJumpKeyDown, isQuoteBelow, isSelectionMode, quotedJumpTarget])

  const handlePlayVideo = useCallback(async () => {
    if (!videoInfo?.videoUrl) return
    try {
      await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
    } catch (e) {
      console.error('打开视频播放窗口失败:', e)
    }
  }, [videoInfo?.videoUrl])

  // Selection mode handling removed from here to allow normal rendering
  // We will wrap the output instead
  if (isSystem) {
    const isPatSystemMessage = message.localType === 266287972401
    const patTitleRaw = isPatSystemMessage
      ? (queryAppMsgText('appmsg > title') || queryAppMsgText('title') || message.parsedContent || '')
      : ''
    const patDisplayText = isPatSystemMessage
      ? cleanMessageContent(String(patTitleRaw).replace(/^\s*\[拍一拍\]\s*/i, ''))
      : ''
    const systemContentNode = isPatSystemMessage
      ? renderTextWithEmoji(patDisplayText || '拍一拍')
      : message.parsedContent

    return (
      <div
        className={`message-bubble system ${isSelectionMode ? 'selectable' : ''}`}
        onContextMenu={(e) => onContextMenu?.(e, message)}
        style={{ cursor: isSelectionMode ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        onClick={(e) => {
          if (isSelectionMode) {
            e.stopPropagation()
            onToggleSelection?.(messageKey, e.shiftKey)
          }
        }}
      >
        {isSelectionMode && (
          <div className={`checkbox ${isSelected ? 'checked' : ''}`} style={{
            width: '20px',
            height: '20px',
            borderRadius: '4px',
            border: isSelected ? 'none' : '2px solid rgba(128,128,128,0.5)',
            backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            flexShrink: 0
          }}>
            {isSelected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        <div className="bubble-content">{systemContentNode}</div>
      </div>
    )
  }

  // 渲染消息内容
  const renderContent = () => {
    if (isImage) {
      const imageContent = (
        <div
          ref={imageContainerRef}
          className={`image-stage ${imageStageLockHeight ? 'locked' : ''}`}
          style={imageStageLockStyle}
        >
          {imageLoading ? (
            <div className="image-loading">
              <Loader2 size={20} className="spin" />
            </div>
          ) : imageError || !imageLocalPath ? (
            <button
              className={`image-unavailable ${imageClicked ? 'clicked' : ''} ${imageError ? 'error' : ''}`}
              onClick={handleImageClick}
              disabled={imageLoading}
              type="button"
            >
              <ImageIcon size={24} />
              <span>{imageError ? '解密失败' : '图片未解密'}</span>
              {imageErrorReason && <span className="image-error-reason">{imageErrorReason}</span>}
              <span className="image-action">{imageClicked ? '已点击…' : '点击重试'}</span>
            </button>
          ) : (
            <>
              <div className="image-message-wrapper">
                <img
                  ref={imageElementRef}
                  src={imageLocalPath}
                  alt="图片"
                  className={`image-message ${imageLoaded ? 'ready' : 'pending'}`}
                  loading="lazy"
                  decoding="async"
                  onClick={() => { void handleOpenImageViewer() }}
                  onLoad={() => {
                    setImageLoaded(true)
                    setImageError(false)
                    setImageErrorReason(undefined)
                    setImageFailureKind(undefined)
                    stabilizeImageScrollAfterResize()
                    releaseImageStageLock()
                  }}
                  onError={() => {
                    imageResizeBaselineRef.current = null
                    setImageLoaded(false)
                    setImageError(true)
                    releaseImageStageLock()
                  }}
                />
                {imageLiveVideoPath && (
                  <div className="media-badge live">
                    <LivePhotoIcon size={14} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )

      if (hasQuote) {
        return renderBubbleWithQuote(
          renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(quotedContent))),
          imageContent
        )
      }

      return <div className="bubble-content">{imageContent}</div>
    }

    // 视频消息
    if (isVideo) {
      let videoContent: React.ReactNode

      // 未进入可视区域时显示占位符
      if (!isVideoVisible) {
        videoContent = (
          <div className="video-placeholder" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
          </div>
        )
      } else if (videoLoading) {
        // 加载中
        videoContent = (
          <div className="video-loading" ref={videoContainerRef as React.RefObject<HTMLDivElement>}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      } else if (!videoInfo?.exists || !videoInfo.videoUrl) {
        // 视频不存在 - 添加点击重试功能
        videoContent = (
          <button
            className={`video-unavailable ${videoClicked ? 'clicked' : ''}`}
            ref={videoContainerRef as React.RefObject<HTMLButtonElement>}
            onClick={() => {
              setVideoClicked(true)
              setTimeout(() => setVideoClicked(false), 800)
              videoAutoLoadTriggered.current = false
              void requestVideoInfo()
            }}
            type="button"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
            <span>视频未找到</span>
            <span className="video-action">{videoClicked ? '已点击…' : '点击重试'}</span>
          </button>
        )
      } else {
        // 默认显示缩略图，点击打开独立播放窗口
        const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
        videoContent = (
          <div className="video-thumb-wrapper" ref={videoContainerRef as React.RefObject<HTMLDivElement>} onClick={handlePlayVideo}>
            {thumbSrc ? (
              <img src={thumbSrc} alt="视频缩略图" className="video-thumb" loading="lazy" decoding="async" />
            ) : (
              <div className="video-thumb-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="23 7 16 12 23 17 23 7"></polygon>
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
              </div>
            )}
            <div className="video-play-button">
              <Play size={32} fill="white" />
            </div>
          </div>
        )
      }

      if (hasQuote) {
        return renderBubbleWithQuote(
          renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(quotedContent))),
          videoContent
        )
      }

      return <div className="bubble-content">{videoContent}</div>
    }

    if (isVoice) {
      const durationText = message.voiceDurationSeconds ? `${message.voiceDurationSeconds}"` : ''
      const handleToggle = async () => {
        if (voiceLoading) return
        if (!voiceWaveformRequested) {
          setVoiceWaveformRequested(true)
        }
        const audio = voiceAudioRef.current || new Audio()
        if (!voiceAudioRef.current) {
          voiceAudioRef.current = audio
        }
        if (isVoicePlaying) {
          audio.pause()
          audio.currentTime = 0
          globalVoiceManager.stop(audio)
          return
        }
        if (!voiceDataUrl) {
          setVoiceLoading(true)
          setVoiceError(false)
          try {
            const result = await window.electronAPI.chat.getVoiceData(
              session.username,
              String(message.localId),
              message.createTime,
              message.serverIdRaw || message.serverId
            )
            if (result.success && result.data) {
              const url = `data:audio/wav;base64,${result.data}`
              voiceDataUrlCache.set(voiceCacheKey, url)
              setVoiceDataUrl(url)
            } else {
              setVoiceError(true)
              return
            }
          } catch {
            setVoiceError(true)
            return
          } finally {
            setVoiceLoading(false)
          }
        }
        const source = voiceDataUrlCache.get(voiceCacheKey) || voiceDataUrl
        if (!source) {
          setVoiceError(true)
          return
        }
        audio.src = source
        try {
          // 停止其他正在播放的语音，确保同一时间只播放一条
          globalVoiceManager.play(audio, () => {
            audio.pause()
            audio.currentTime = 0
          })
          await audio.play()
        } catch {
          setVoiceError(true)
        }
      }

      const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!voiceDataUrl || !voiceAudioRef.current) return
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const percentage = x / rect.width
        const newTime = percentage * voiceDuration
        voiceAudioRef.current.currentTime = newTime
        setVoiceCurrentTime(newTime)
      }

      const showDecryptHint = !voiceDataUrl && !voiceLoading && !isVoicePlaying
      const showTranscript = Boolean(voiceDataUrl) && (voiceTranscriptLoading || voiceTranscriptError || voiceTranscript !== undefined)
      const transcriptText = (voiceTranscript || '').trim()
      const transcriptDisplay = voiceTranscriptLoading
        ? '转写中...'
        : voiceTranscriptError
          ? '转写失败，点击重试'
          : (transcriptText || '未识别到文字')
      const handleTranscriptRetry = () => {
        if (!voiceTranscriptError) return
        voiceTranscriptRequestedRef.current = false
        void requestVoiceTranscript()
      }

      const voiceContent = (
        <div className="voice-stack">
          <div className={`voice-message ${isVoicePlaying ? 'playing' : ''}`} onClick={handleToggle}>
            <button
              className="voice-play-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleToggle()
              }}
              aria-label="播放语音"
              type="button"
            >
              {isVoicePlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <div className="voice-wave" onClick={handleSeek}>
              {voiceDataUrl && voiceWaveform.length > 0 ? (
                <div className="voice-waveform">
                  {voiceWaveform.map((amplitude, i) => {
                    const progress = (voiceCurrentTime / (voiceDuration || 1))
                    const isPlayed = (i / voiceWaveform.length) < progress
                    return (
                      <div
                        key={i}
                        className={`waveform-bar ${isPlayed ? 'played' : ''}`}
                        style={{ height: `${Math.max(20, amplitude * 100)}%` }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="voice-wave-placeholder">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            <div className="voice-info">
              <span className="voice-label">语音</span>
              {durationText && <span className="voice-duration">{durationText}</span>}
              {voiceLoading && <span className="voice-loading">解码中...</span>}
              {showDecryptHint && <span className="voice-hint">点击解密</span>}
              {voiceError && <span className="voice-error">播放失败</span>}
            </div>
            {/* 转文字按钮 */}
            {voiceDataUrl && !voiceTranscript && !voiceTranscriptLoading && (
              <button
                className="voice-transcribe-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void requestVoiceTranscript()
                }}
                title="转文字"
                type="button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
          </div>
          {showTranscript && (
            <div
              className={`voice-transcript ${isSent ? 'sent' : 'received'}${voiceTranscriptError ? ' error' : ''}`}
              onClick={handleTranscriptRetry}
              title={voiceTranscriptError ? '点击重试语音转写' : undefined}
            >
              {voiceTranscriptError ? (
                '转写失败，点击重试'
              ) : !voiceTranscript ? (
                voiceTranscriptLoading ? '转写中...' : '未识别到文字'
              ) : (
                <AnimatedStreamingText
                  text={transcriptText}
                  loading={voiceTranscriptLoading}
                />
              )}
            </div>
          )}
        </div>
      )

      if (hasQuote) {
        return renderBubbleWithQuote(
          renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(quotedContent))),
          voiceContent
        )
      }

      return <div className="bubble-content">{voiceContent}</div>
    }

    // 名片消息
    if (isCard) {
      const cardName = message.cardNickname || message.cardUsername || '未知联系人'
      const cardAvatar = message.cardAvatarUrl
      return (
        <div className="card-message">
          <div className="card-icon">
            {cardAvatar ? (
              <img src={cardAvatar} alt="" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '8px' }} referrerPolicy="no-referrer" />
            ) : (
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </div>
          <div className="card-info">
            <div className="card-name">{cardName}</div>
            {message.cardUsername && message.cardUsername !== message.cardNickname && (
              <div className="card-wxid">微信号: {message.cardUsername}</div>
            )}
            <div className="card-label">个人名片</div>
          </div>
        </div>
      )
    }

    // 通话消息
    if (isCall) {
      return (
        <div className="bubble-content">
          <div className="call-message">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            <span>{message.parsedContent || '[通话]'}</span>
          </div>
        </div>
      )
    }

    // 位置消息
    if (message.localType === 48) {
      if (!locationMessageMeta) return null
      const { poiname, label, lat, lng, mapTileUrl } = locationMessageMeta
      return (
        <div className="location-message" onClick={() => window.electronAPI.shell.openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(poiname || label)}`)}>
          <div className="location-text">
            <div className="location-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <div className="location-info">
              {poiname && <div className="location-name">{poiname}</div>}
              {label && <div className="location-label">{label}</div>}
            </div>
          </div>
          {mapTileUrl && (
            <div className="location-map">
              <img src={mapTileUrl} alt="地图" referrerPolicy="no-referrer" />
            </div>
          )}
        </div>
      )
    }

    // 链接消息 (AppMessage)
    const appMsgRichPreview = (() => {
      const rawXml = appMsgRawXml
      if (!appMsgContainsTag) return null
      const q = queryAppMsgText

      const xmlType = message.xmlType || q('appmsg > type') || q('type')

      // type 62: 拍一拍（按普通文本渲染，支持 [烟花] 这类 emoji 占位符）
      if (xmlType === '62') {
        const patText = cleanMessageContent((q('title') || cleanedParsedContent || '').replace(/^\s*\[拍一拍\]\s*/i, ''))
        return <div className="bubble-content">{renderTextWithEmoji(patText || '拍一拍')}</div>
      }

      // type 57: 引用回复消息，解析 refermsg 渲染为引用样式
      if (xmlType === '57') {
        const replyText = q('title') || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        const referType = q('refermsg > type') || ''

        // 根据被引用消息类型渲染对应内容
        const renderReferContent = () => {
          // 动画表情：解析嵌套 XML 提取 cdnurl 渲染
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }

          // 链接类消息：需区分真正的链接和嵌套引用
          // 当一个引用了别的消息的消息被引用（B引用A，C又引用B），那么 B 在 C 的 refermsg 里 type=49
          // 与此同时，一个链接的 type 也是 49，这可能意味着 49 是一个更高级别的分类
          // 因此，不能将 type=49 的引用信息一律视为链接，它也可能是嵌套引用。那么怎么区分呢？
          // 答：嵌套引用的 referContent 中 xmlType=57，真正的链接 xmlType=49 或 5
          // 对于更多层的嵌套引用，微信不会保存所有层的信息，因此和两层的情况差不多
          // 注意：需从原始 XML 获取 refermsg > content，而非后端处理过的 quotedContent
          if (referType === '49') {
            try {
              const rawReferContent = q('refermsg > content') || ''
              const innerDoc = new DOMParser().parseFromString(rawReferContent, 'text/xml')
              const innerXmlType = innerDoc.querySelector('appmsg > type')?.textContent?.trim()
              if (innerXmlType === '57') {
                const innerTitle = innerDoc.querySelector('title')?.textContent?.trim() || ''
                if (innerTitle) return <>{renderTextWithEmoji(cleanMessageContent(innerTitle))}</>
              }
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[链接]</span>
          }

          // 各类型名称映射
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }

          // 普通文本或未知类型
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderReferContent()),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      if (xmlType === '53' || message.appMsgKind === 'solitaire') {
        const solitaireText = message.linkTitle || q('appmsg > title') || q('title') || cleanedParsedContent || '接龙'
        const solitaire = parseSolitaireContent(solitaireText)
        const previewEntries = solitaireExpanded ? solitaire.entries : solitaire.entries.slice(0, 3)
        const hiddenEntryCount = Math.max(0, solitaire.entries.length - previewEntries.length)
        const introLines = solitaireExpanded ? solitaire.introLines : solitaire.introLines.slice(0, 4)
        const hasMoreIntro = !solitaireExpanded && solitaire.introLines.length > introLines.length
        const countText = solitaire.entries.length > 0 ? `${solitaire.entries.length} 人参与` : '接龙消息'

        return (
          <div
            className={`solitaire-message${solitaireExpanded ? ' expanded' : ''}`}
            role="button"
            tabIndex={0}
            aria-expanded={solitaireExpanded}
            onClick={isSelectionMode ? undefined : (e) => {
              e.stopPropagation()
              setSolitaireExpanded(value => !value)
            }}
            onKeyDown={isSelectionMode ? undefined : (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              setSolitaireExpanded(value => !value)
            }}
            title={solitaireExpanded ? '点击收起接龙' : '点击展开接龙'}
          >
            <div className="solitaire-header">
              <div className="solitaire-icon" aria-hidden="true">
                <Hash size={18} />
              </div>
              <div className="solitaire-heading">
                <div className="solitaire-title">{solitaire.title}</div>
                <div className="solitaire-meta">{countText}</div>
              </div>
            </div>
            {introLines.length > 0 && (
              <div className="solitaire-intro">
                {introLines.map((line, index) => (
                  <div key={`${line}-${index}`} className="solitaire-intro-line">{line}</div>
                ))}
                {hasMoreIntro && <div className="solitaire-muted-line">...</div>}
              </div>
            )}
            {previewEntries.length > 0 ? (
              <div className="solitaire-entry-list">
                {previewEntries.map(entry => (
                  <div key={`${entry.index}-${entry.text}`} className="solitaire-entry">
                    <span className="solitaire-entry-index">{entry.index}</span>
                    <span className="solitaire-entry-text">{entry.text}</span>
                  </div>
                ))}
                {hiddenEntryCount > 0 && (
                  <div className="solitaire-muted-line">还有 {hiddenEntryCount} 条...</div>
                )}
              </div>
            ) : null}
            <div className="solitaire-footer">
              <span>{solitaireExpanded ? '收起接龙' : '展开接龙'}</span>
              <ChevronDown size={14} className="solitaire-chevron" />
            </div>
          </div>
        )
      }

      const title = message.linkTitle || q('title') || cleanedParsedContent || 'Card'
      const desc = message.appMsgDesc || q('des')
      const url = message.linkUrl || q('url')
      const fallbackThumbUrl = appMsgThumbRawCandidate
      const thumbUrl = isRenderableImageSrc(fallbackThumbUrl) ? fallbackThumbUrl : ''
      const musicUrl = message.appMsgMusicUrl || message.appMsgDataUrl || q('musicurl') || q('playurl') || q('dataurl') || q('lowurl')
      const sourceName = message.appMsgSourceName || q('sourcename')
      const sourceDisplayName = q('sourcedisplayname') || ''
      const appName = message.appMsgAppName || q('appname')
      const sourceUsername = message.appMsgSourceUsername || q('sourceusername')
      const finderName =
        message.finderNickname ||
        message.finderUsername ||
        q('findernickname') ||
        q('finder_nickname') ||
        q('finderusername') ||
        q('finder_username')

      const lower = rawXml.toLowerCase()

      const kind = message.appMsgKind || (
        (xmlType === '2001' || lower.includes('hongbao')) ? 'red-packet'
          : (xmlType === '115' ? 'gift'
            : ((xmlType === '33' || xmlType === '36') ? 'miniapp'
              : (((xmlType === '5' || xmlType === '49') && (sourceUsername.startsWith('gh_') || !!sourceName || appName.includes('公众号'))) ? 'official-link'
                : (xmlType === '51' ? 'finder'
                  : (xmlType === '3' ? 'music'
                    : ((xmlType === '5' || xmlType === '49') ? 'link' // Fallback for standard links
                      : (!!musicUrl ? 'music' : '')))))))
      )

      if (!kind) return null

      // 对视频号提取真实标题，避免出现 "当前版本不支持该内容"
      let displayTitle = title
      if (kind === 'finder' && (!displayTitle || displayTitle.includes('不支持'))) {
        displayTitle = q('finderFeed > desc') || q('finderFeed desc') || desc || ''
      }

      const openExternal = (e: React.MouseEvent, nextUrl?: string) => {
        if (!nextUrl) return
        e.stopPropagation()
        if (window.electronAPI?.shell?.openExternal) {
          window.electronAPI.shell.openExternal(nextUrl)
        } else {
          window.open(nextUrl, '_blank')
        }
      }

      const metaLabel =
        kind === 'red-packet' ? '红包'
          : kind === 'finder' ? (finderName || '视频号')
            : kind === 'location' ? '位置'
              : kind === 'music' ? (sourceName || appName || '音乐')
                : (sourceName || appName || (sourceUsername.startsWith('gh_') ? '公众号' : ''))

      const renderCard = (cardKind: string, clickableUrl?: string) => (
        <div
          className={`link-message appmsg-rich-card ${cardKind}`}
          onClick={clickableUrl ? (e) => openExternal(e, clickableUrl) : undefined}
          title={clickableUrl}
        >
          <div className="link-header">
            <div className="link-title" title={title}>{title}</div>
            {metaLabel ? <div className="appmsg-meta-badge">{metaLabel}</div> : null}
          </div>
          <div className="link-body">
            <div className="link-desc-block">
              {desc ? <div className="link-desc" title={desc}>{desc}</div> : null}
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`link-thumb${((cardKind === 'miniapp') || /\.svg(?:$|\?)/i.test(thumbUrl)) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        </div>
      )

      if (kind === 'quote') {
        // 引用回复消息（appMsgKind='quote'，xmlType=57）
        const replyText = message.linkTitle || q('title') || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(referContent))),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      if (kind === 'red-packet') {
        // 专属红包卡片
        const greeting = q('receivertitle') || q('sendertitle') || ''
        return (
          <div className="hongbao-message">
            <div className="hongbao-icon">
              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                <rect x="4" y="6" width="32" height="28" rx="4" fill="white" fillOpacity="0.3" />
                <rect x="4" y="6" width="32" height="14" rx="4" fill="white" fillOpacity="0.2" />
                <circle cx="20" cy="20" r="6" fill="white" fillOpacity="0.4" />
                <text x="20" y="24" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">¥</text>
              </svg>
            </div>
            <div className="hongbao-info">
              <div className="hongbao-greeting">{greeting || '恭喜发财，大吉大利'}</div>
              <div className="hongbao-label">微信红包</div>
            </div>
          </div>
        )
      }

      if (kind === 'gift') {
        // 礼物卡片
        const giftImg = message.giftImageUrl || thumbUrl
        const giftWish = message.giftWish || title || '送你一份心意'
        const giftPriceRaw = message.giftPrice
        const giftPriceYuan = giftPriceRaw ? (parseInt(giftPriceRaw) / 100).toFixed(2) : ''
        return (
          <div className="gift-message">
            {giftImg && <img className="gift-img" src={giftImg} alt="" referrerPolicy="no-referrer" />}
            <div className="gift-info">
              <div className="gift-wish">{giftWish}</div>
              {giftPriceYuan && <div className="gift-price">¥{giftPriceYuan}</div>}
              <div className="gift-label">微信礼物</div>
            </div>
          </div>
        )
      }

      if (kind === 'finder') {
        // 视频号专属卡片
        const coverUrl = message.finderCoverUrl || thumbUrl
        const duration = message.finderDuration
        const authorName = finderName || ''
        const authorAvatar = message.finderAvatar
        const fmtDuration = duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''
        return (
          <div className="channel-video-card" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="channel-video-cover">
              {coverUrl ? (
                <img src={coverUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="channel-video-cover-placeholder">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
              )}
              {fmtDuration && <span className="channel-video-duration">{fmtDuration}</span>}
            </div>
            <div className="channel-video-info">
              <div className="channel-video-title">{displayTitle || '视频号视频'}</div>
              <div className="channel-video-author">
                {authorAvatar && <img className="channel-video-avatar" src={authorAvatar} alt="" referrerPolicy="no-referrer" />}
                <span>{authorName || '视频号'}</span>
              </div>
            </div>
          </div>
        )
      }



      if (kind === 'music') {
        // 音乐专属卡片
        const albumUrl = message.musicAlbumUrl || thumbUrl
        const playUrl = message.musicUrl || musicUrl || url
        const songTitle = title || '未知歌曲'
        const artist = desc || ''
        const appLabel = sourceName || appName || ''
        return (
          <div className="music-message" onClick={playUrl ? (e) => openExternal(e, playUrl) : undefined}>
            <div className="music-cover">
              {albumUrl ? (
                <img src={albumUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </div>
            <div className="music-info">
              <div className="music-title">{songTitle}</div>
              {artist && <div className="music-artist">{artist}</div>}
              {appLabel && <div className="music-source">{appLabel}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'official-link') {
        const authorAvatar = q('publisher > headimg') || q('brand_info > headimgurl') || q('appmsg > avatar') || q('headimgurl') || message.cardAvatarUrl
        const authorName = sourceDisplayName || q('publisher > nickname') || sourceName || appName || '公众号'
        const coverPic = q('mmreader > category > item > cover') || thumbUrl
        const digest = q('mmreader > category > item > digest') || desc
        const articleTitle = q('mmreader > category > item > title') || title

        return (
          <div className="official-message" onClick={url ? (e) => openExternal(e, url) : undefined}>
            <div className="official-header">
              {authorAvatar ? (
                <img src={authorAvatar} alt="" className="official-avatar" referrerPolicy="no-referrer" />
              ) : (
                <div className="official-avatar-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
              <span className="official-name">{authorName}</span>
            </div>
            <div className="official-body">
              {coverPic ? (
                <div className="official-cover-wrapper">
                  <img src={coverPic} alt="" className="official-cover" referrerPolicy="no-referrer" />
                  <div className="official-title-overlay">{articleTitle}</div>
                </div>
              ) : (
                <div className="official-title-text">{articleTitle}</div>
              )}
              {digest && <div className="official-digest">{digest}</div>}
            </div>
          </div>
        )
      }

      if (kind === 'link') return renderCard('link', url || undefined)
      if (kind === 'card') return renderCard('card', url || undefined)
      if (kind === 'miniapp') {
        return (
          <div className="miniapp-message miniapp-message-rich">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">{metaLabel || '小程序'}</div>
            </div>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                className={`miniapp-thumb${/\.svg(?:$|\?)/i.test(thumbUrl) ? ' theme-adaptive' : ''}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        )
      }
      return null
    })()

    if (appMsgRichPreview) {
      return appMsgRichPreview
    }

    if (appMsgContainsTag) {
      const q = queryAppMsgText
      const title = q('title') || '链接'
      const desc = q('des')
      const url = q('url')
      const appMsgType = message.xmlType || q('appmsg > type') || q('type')
      const textAnnouncement = q('textannouncement')
      const parsedDoc: Document | null = appMsgDoc

      // 引用回复消息 (type=57)，防止被误判为链接
      if (appMsgType === '57') {
        const replyText = parsedDoc?.querySelector('title')?.textContent?.trim() || cleanedParsedContent || ''
        const referContent = queryPreferredQuotedContent()
        const referType = parsedDoc?.querySelector('refermsg > type')?.textContent?.trim() || ''

        const renderReferContent2 = () => {
          if (referType === '47') {
            try {
              const innerDoc = new DOMParser().parseFromString(referContent, 'text/xml')
              const cdnUrl = innerDoc.querySelector('emoji')?.getAttribute('cdnurl') || ''
              const md5 = innerDoc.querySelector('emoji')?.getAttribute('md5') || ''
              if (cdnUrl) return <QuotedEmoji cdnUrl={cdnUrl} md5={md5} />
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[动画表情]</span>
          }
          // 链接类消息：需区分真正的链接和嵌套引用
          // 当一个引用了别的消息的消息被引用（B引用A，C又引用B），那么 B 在 C 的 refermsg 里 type=49
          // 与此同时，一个链接的 type 也是 49，这可能意味着 49 是一个更高级别的分类
          // 因此，不能将 type=49 的引用信息一律视为链接，它也可能是嵌套引用。那么怎么区分呢？
          // 答：嵌套引用的 referContent 中 xmlType=57，真正的链接 xmlType=49 或 5
          // 对于更多层的嵌套引用，微信不会保存所有层的信息，因此和两层的情况差不多
          // 注意：需从原始 XML 获取 refermsg > content，而非后端处理过的 quotedContent
          if (referType === '49') {
            try {
              const rawReferContent = parsedDoc?.querySelector('refermsg > content')?.textContent?.trim() || ''
              const innerDoc = new DOMParser().parseFromString(rawReferContent, 'text/xml')
              const innerXmlType = innerDoc.querySelector('appmsg > type')?.textContent?.trim()
              if (innerXmlType === '57') {
                const innerTitle = innerDoc.querySelector('title')?.textContent?.trim() || ''
                if (innerTitle) return <>{renderTextWithEmoji(cleanMessageContent(innerTitle))}</>
              }
            } catch { /* 解析失败降级 */ }
            return <span className="quoted-type-label">[链接]</span>
          }
          // 各类型名称映射
          const typeLabels: Record<string, string> = {
            '3': '图片', '34': '语音', '43': '视频',
            '50': '通话', '10000': '系统消息', '10002': '撤回消息',
          }
          if (referType && typeLabels[referType]) {
            return <span className="quoted-type-label">[{typeLabels[referType]}]</span>
          }
          return <>{renderTextWithEmoji(cleanMessageContent(referContent))}</>
        }

        return (
          renderBubbleWithQuote(
            renderQuotedMessageBlock(renderReferContent2()),
            <div className="message-text">{renderTextWithEmoji(cleanMessageContent(replyText))}</div>
          )
        )
      }

      // 群公告消息 (type=87)
      if (appMsgType === '87') {
        const announcementText = textAnnouncement || desc || '群公告'
        return (
          <div className="announcement-message">
            <div className="announcement-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="announcement-content">
              <div className="announcement-label">群公告</div>
              <div className="announcement-text">{announcementText}</div>
            </div>
          </div>
        )
      }

      // 聊天记录 (type=19)
      if (appMsgType === '19') {
        const recordList = message.chatRecordList || []
        const displayTitle = title || '群聊的聊天记录'
        const metaText =
          recordList.length > 0
            ? `共 ${recordList.length} 条聊天记录`
            : desc || '聊天记录'

        const previewItems = buildChatRecordPreviewItems(recordList, 3)
        const remainingCount = Math.max(0, recordList.length - previewItems.length)

        return (
          <div
            className="chat-record-message"
            onClick={(e) => {
              e.stopPropagation()
              // 打开聊天记录窗口
              window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
            }}
            title="点击查看详细聊天记录"
          >
            <div className="chat-record-title" title={displayTitle}>
              {displayTitle}
            </div>
            <div className="chat-record-meta-line" title={metaText}>
              {metaText}
            </div>
            {previewItems.length > 0 ? (
              <div className="chat-record-list">
                {previewItems.map((item, i) => (
                  <div key={i} className="chat-record-item">
                    <span className="source-name">
                      {hasRenderableChatRecordName(item.sourcename) ? `${item.sourcename}: ` : ''}
                    </span>
                    {getChatRecordPreviewText(item)}
                  </div>
                ))}
                {remainingCount > 0 && (
                  <div className="chat-record-more">还有 {remainingCount} 条…</div>
                )}
              </div>
            ) : (
              <div className="chat-record-desc">
                {desc || '点击打开查看完整聊天记录'}
              </div>
            )}
            <div className="chat-record-footer">聊天记录</div>
          </div>
        )
      }

      // 文件消息 (type=6)
      if (appMsgType === '6') {
        const fileName = message.fileName || title || '文件'
        const fileSize = message.fileSize
        const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''

        // 根据扩展名选择图标
        const getFileIcon = () => {
          const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
          if (archiveExts.includes(fileExt)) {
            return (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )
          }
          return (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
          )
        }

        return (
          <div className="file-message">
            <div className="file-icon">
              {getFileIcon()}
            </div>
            <div className="file-info">
              <div className="file-name" title={fileName}>{fileName}</div>
              <div className="file-meta">
                {fileSize ? formatFileSize(fileSize) : ''}
              </div>
            </div>
          </div>
        )
      }

      // 转账消息 (type=2000)
      if (appMsgType === '2000') {
        try {
          // 使用外层已解析好的 parsedDoc（已去除 wxid 前缀）
          const feedesc = parsedDoc?.querySelector('feedesc')?.textContent || ''
          const payMemo = parsedDoc?.querySelector('pay_memo')?.textContent || ''
          const paysubtype = parsedDoc?.querySelector('paysubtype')?.textContent || '1'

          // paysubtype: 1=待收款, 3=已收款
          const isReceived = paysubtype === '3'

          // 如果 feedesc 为空，使用 title 作为降级
          const displayAmount = feedesc || title || '微信转账'

          // 构建转账描述：A 转账给 B
          const transferDesc = transferPayerName && transferReceiverName
            ? `${transferPayerName} 转账给 ${transferReceiverName}`
            : undefined

          return (
            <div className={`transfer-message ${isReceived ? 'received' : ''}`}>
              <div className="transfer-icon">
                {isReceived ? (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{displayAmount}</div>
                {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
                {payMemo && <div className="transfer-memo">{payMemo}</div>}
                <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
              </div>
            </div>
          )
        } catch (e) {
          console.error('[Transfer Debug] Parse error:', e)
          // 解析失败时的降级处理
          const feedesc = title || '微信转账'
          return (
            <div className="transfer-message">
              <div className="transfer-icon">
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                  <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="transfer-info">
                <div className="transfer-amount">{feedesc}</div>
                <div className="transfer-label">微信转账</div>
              </div>
            </div>
          )
        }
      }

      // 小程序 (type=33/36)
      if (appMsgType === '33' || appMsgType === '36') {
        return (
          <div className="miniapp-message">
            <div className="miniapp-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="miniapp-info">
              <div className="miniapp-title">{title}</div>
              <div className="miniapp-label">小程序</div>
            </div>
          </div>
        )
      }

      // 有 URL 的链接消息
      if (url) {
        return (
          <div
            className="link-message"
            onClick={(e) => {
              e.stopPropagation()
              if (window.electronAPI?.shell?.openExternal) {
                window.electronAPI.shell.openExternal(url)
              } else {
                window.open(url, '_blank')
              }
            }}
          >
            <div className="link-header">
              <div className="link-title" title={title}>{title}</div>
            </div>
            <div className="link-body">
              <div className="link-desc" title={desc}>{desc}</div>
            </div>
          </div>
        )
      }
    }

    // 表情包消息
    if (isEmoji) {
      // ... (keep existing emoji logic)
      // 没有 cdnUrl 或加载失败，显示占位符
      if ((!message.emojiCdnUrl && !message.emojiLocalPath) || emojiError) {
        return (
          <div className="emoji-message-wrapper" ref={emojiContainerRef}>
            <div className="emoji-unavailable">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 15s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
              <span>表情包未缓存</span>
            </div>
          </div>
        )
      }

      // 显示加载中
      if (emojiLoading || !emojiLocalPath) {
        return (
          <div className="emoji-message-wrapper" ref={emojiContainerRef}>
            <div className="emoji-loading">
              <Loader2 size={20} className="spin" />
            </div>
          </div>
        )
      }

      // 显示表情图片
      return (
        <div className="emoji-message-wrapper" ref={emojiContainerRef}>
          <img
            src={emojiLocalPath}
            alt="表情"
            className="emoji-image"
            onLoad={() => {
              setEmojiError(false)
              stabilizeEmojiScrollAfterResize()
            }}
            onError={() => {
              emojiResizeBaselineRef.current = null
              setEmojiError(true)
            }}
          />
        </div>
      )
    }

    // 解析引用消息（Links / App Messages）
    // localType: 21474836529 corresponds to AppMessage which often contains links

    // 带引用的消息
    if (hasQuote) {
      return renderBubbleWithQuote(
        renderQuotedMessageBlock(renderTextWithEmoji(cleanMessageContent(quotedContent))),
        <div className="message-text">{renderTextWithEmoji(cleanedParsedContent)}</div>
      )
    }

    // 普通消息
    return <div className="bubble-content">{renderTextWithEmoji(cleanedParsedContent)}</div>
  }

  const systemAlertPortal = systemAlert ? createPortal(
    <div className="modal-overlay" onClick={() => setSystemAlert(null)} style={{ zIndex: 99999 }}>
      <div className="delete-confirm-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
        <div className="confirm-icon">
          <AlertCircle size={32} color="var(--danger)" />
        </div>
        <div className="confirm-content">
          <h3>{systemAlert.title}</h3>
          <p style={{ marginTop: '12px', lineHeight: '1.6', fontSize: '14px', color: 'var(--text-secondary)' }}>
            {systemAlert.message}
          </p>
        </div>
        <div className="confirm-actions" style={{ justifyContent: 'center', marginTop: '24px' }}>
          <button
            className="btn-primary"
            onClick={() => setSystemAlert(null)}
            style={{ padding: '8px 32px' }}
          >
            确认
          </button>
        </div>
      </div>
    </div>,
    document.body
  ) : null

  return (
    <ChatMessageBubble
      message={message}
      messageKey={messageKey}
      session={session}
      showTime={showTime}
      timeText={formatTime(message.createTime)}
      isSent={isSent}
      isSystem={isSystem}
      isEmoji={isEmoji}
      isImage={isImage}
      isVideo={isVideo}
      isVoice={isVoice}
      emojiHasAsset={Boolean(message.emojiCdnUrl || message.emojiLocalPath)}
      emojiError={emojiError}
      avatarUrl={avatarUrl}
      isGroupChat={isGroupChat}
      resolvedSenderName={resolvedSenderName}
      isSelectionMode={isSelectionMode}
      isSelected={isSelected}
      onContextMenu={onContextMenu}
      onToggleSelection={onToggleSelection}
      portal={systemAlertPortal}
    >
      {renderContent()}
    </ChatMessageBubble>
  )
}

const MemoMessageBubble = React.memo(MessageBubble, (prevProps, nextProps) => {
  if (prevProps.message !== nextProps.message) return false
  if (prevProps.messageKey !== nextProps.messageKey) return false
  if (prevProps.showTime !== nextProps.showTime) return false
  if (prevProps.myAvatarUrl !== nextProps.myAvatarUrl) return false
  if (prevProps.myWxid !== nextProps.myWxid) return false
  if (prevProps.isGroupChat !== nextProps.isGroupChat) return false
  if (prevProps.quoteLayout !== nextProps.quoteLayout) return false
  if (prevProps.autoTranscribeVoiceEnabled !== nextProps.autoTranscribeVoiceEnabled) return false
  if (prevProps.isSelectionMode !== nextProps.isSelectionMode) return false
  if (prevProps.isSelected !== nextProps.isSelected) return false
  if (prevProps.onRequireModelDownload !== nextProps.onRequireModelDownload) return false
  if (prevProps.onContextMenu !== nextProps.onContextMenu) return false
  if (prevProps.onJumpToQuotedMessage !== nextProps.onJumpToQuotedMessage) return false
  if (prevProps.onToggleSelection !== nextProps.onToggleSelection) return false

  return (
    prevProps.session.username === nextProps.session.username &&
    prevProps.session.displayName === nextProps.session.displayName &&
    prevProps.session.avatarUrl === nextProps.session.avatarUrl
  )
})

export function clearMessageBubbleMediaCaches(): void {
  emojiDataUrlCache.clear()
  imageDataUrlCache.clear()
  voiceDataUrlCache.clear()
  voiceTranscriptCache.clear()
  imageDecryptInFlight.clear()
  senderAvatarCache.clear()
  senderAvatarLoading.clear()
}

export function hasImageDataUrlCached(cacheKey: string): boolean {
  return imageDataUrlCache.has(cacheKey)
}

export { senderAvatarCache, senderAvatarLoading }
export { MemoMessageBubble }
export default MemoMessageBubble
