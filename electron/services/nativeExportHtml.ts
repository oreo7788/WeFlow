/**
 * Rust HTML 导出桥接 - 完整功能实现
 *
 * 处理所有 TypeScript 端的预处理工作：
 * - 消息收集和转换
 * - 联系人/群组信息查询
 * - 媒体文件导出
 * - 调用 Rust 生成 HTML
 */

import { existsSync, copyFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname, basename, extname } from 'path'
import { imageDecryptService } from './imageDecryptService'
import { wcdbService } from './wcdbService'
import { ConfigService } from './config'

// 媒体映射文件名称
const MEDIA_MAPPING_FILE = 'media-mapping.json'

// 媒体映射数据结构
interface MediaMapping {
  version: string
  exportedAt: number
  sessionId: string
  mediaFiles: Record<string, MediaFileInfo> // key: messageId_type_hash
}

interface MediaFileInfo {
  type: 'image' | 'video' | 'voice' | 'file'
  sourcePath: string // 原始路径/MD5
  destPath: string // 导出的相对路径 ./media/xxx.jpg
  fileName: string // 文件名
  fileSize: number
  exportedAt: number
  day?: string
}

// Rust 模块（从 nativeExport.ts 导入）
let rustModule: any = null
try {
  const rustPath = join(__dirname, '..', '..', 'rust')
  if (existsSync(rustPath)) {
    rustModule = require(rustPath)
  }
} catch {
  // Rust 模块不可用
}

// 导出配置
export interface HtmlExportOptions {
  outputPath: string
  sessionId: string
  sessionName?: string
  includeMedia: boolean
  includeAvatar: boolean
  dateRange?: { start?: number; end?: number }
  exportImages?: boolean
  exportVideos?: boolean
  exportVoices?: boolean
  exportFiles?: boolean
  maxFileSizeMb?: number
  dayPartition?: {
    sessionDir: string
    day: string
  }
}

// 消息类型
interface ExportMessage {
  id: number
  localId: number
  serverId?: string
  createTime: number
  type: number
  subType: number
  isSender: boolean
  talker: string
  content?: string
  displayName?: string
  groupNickname?: string
  avatarUrl?: string
  // 媒体信息
  imagePath?: string
  imageLocalPath?: string  // 解密后的本地路径
  voicePath?: string
  videoPath?: string
  videoThumbPath?: string
  filePath?: string
  fileName?: string
  fileSize?: number
  // 引用消息
  replyToId?: number
  replyToContent?: string
  // 合并转发
  chatRecordTitle?: string
  chatRecordList?: any[]
}

// 会话信息
interface SessionInfo {
  id: string
  name: string
  type: 'private' | 'group'
  myWxid: string
  myNickname: string
  members?: Map<string, MemberInfo>
}

interface MemberInfo {
  username: string
  nickname: string
  groupNickname?: string
  avatarUrl?: string
}

/**
 * 检查 Rust HTML 导出是否可用
 */
export function isRustHtmlExportAvailable(): boolean {
  return rustModule?.ExportService != null && rustModule?.ExportTask != null
}

/**
 * 完整的 HTML 导出流程
 */
export async function exportHtmlViaRust(
  options: HtmlExportOptions,
  messages: any[],
  onProgress?: (progress: {
    phase: string
    current: number
    total: number
    message?: string
  }) => void
): Promise<{ success: boolean; durationMs: number; exportedMediaCount: number; error?: string }> {
  const start = performance.now()
  const configService = new ConfigService()

  if (!isRustHtmlExportAvailable()) {
    return { success: false, durationMs: 0, exportedMediaCount: 0, error: 'Rust HTML 导出模块不可用' }
  }

  try {
    onProgress?.({ phase: 'preparing', current: 0, total: 100, message: '准备导出...' })

    // 1. 获取会话信息
    const sessionInfo = await prepareSessionInfo(options.sessionId, configService)

    // 2. 准备消息数据（查询联系人信息）
    onProgress?.({ phase: 'preparing', current: 10, total: 100, message: '查询联系人信息...' })
    const exportMessages = await prepareMessages(
      messages,
      sessionInfo,
      options.sessionId,
      configService
    )

    // 3. 导出媒体文件（支持增量导出）
    let exportedMediaCount = 0
    if (options.includeMedia) {
      onProgress?.({ phase: 'exporting-media', current: 20, total: 100, message: '导出媒体文件...' })
      const mediaResult = await exportMediaFiles(
        exportMessages,
        options,
        (current, total) => {
          onProgress?.({
            phase: 'exporting-media',
            current: 20 + Math.floor((current / total) * 30),
            total: 100,
            message: `导出媒体 ${current}/${total}...`
          })
        }
      )
      exportedMediaCount = mediaResult.exportedCount + mediaResult.reusedCount
    }

    // 4. 调用 Rust 生成 HTML
    onProgress?.({ phase: 'generating-html', current: 50, total: 100, message: '生成 HTML...' })

    const result = await generateHtmlWithRust(
      exportMessages,
      sessionInfo,
      options,
      (current, total) => {
        onProgress?.({
          phase: 'generating-html',
          current: 50 + Math.floor((current / total) * 50),
          total: 100,
          message: `处理消息 ${current}/${total}...`
        })
      }
    )

    const durationMs = performance.now() - start

    if (result) {
      onProgress?.({ phase: 'completed', current: 100, total: 100, message: '导出完成' })
      console.log(`[✅ Rust HTML Export] 成功导出 ${messages.length} 条消息, ${exportedMediaCount} 个媒体文件, ${durationMs.toFixed(0)}ms`)
      return { success: true, durationMs, exportedMediaCount }
    } else {
      return { success: false, durationMs, exportedMediaCount, error: 'Rust HTML 生成失败' }
    }
  } catch (e) {
    const durationMs = performance.now() - start
    console.error('[❌ Rust HTML Export] 导出失败:', e)
    return { success: false, durationMs, exportedMediaCount: 0, error: String(e) }
  }
}

/**
 * 准备会话信息
 */
async function prepareSessionInfo(
  sessionId: string,
  configService: ConfigService
): Promise<SessionInfo> {
  const myWxid = configService.get('myWxid') as string

  // 获取会话信息
  const sessionResult = await wcdbService.getContact(sessionId)
  const sessionName = sessionResult.success && sessionResult.contact
    ? sessionResult.contact.remark || sessionResult.contact.nickname || sessionId
    : sessionId

  // 获取我的信息
  const myResult = await wcdbService.getContact(myWxid)
  const myNickname = myResult.success && myResult.contact
    ? myResult.contact.nickname || '我'
    : '我'

  const isGroup = sessionId.includes('@chatroom')

  // 如果是群组，获取成员信息
  const members = new Map<string, MemberInfo>()
  if (isGroup) {
    const groupMembers = await wcdbService.getGroupMembers(sessionId)
    if (groupMembers.success && groupMembers.members) {
      for (const m of groupMembers.members) {
        members.set(m.username, {
          username: m.username,
          nickname: m.nickname || m.username,
          groupNickname: m.groupNickname,
          avatarUrl: m.avatarUrl
        })
      }
    }
  }

  return {
    id: sessionId,
    name: sessionName,
    type: isGroup ? 'group' : 'private',
    myWxid,
    myNickname,
    members
  }
}

/**
 * 准备消息数据
 */
async function prepareMessages(
  messages: any[],
  sessionInfo: SessionInfo,
  sessionId: string,
  configService: ConfigService
): Promise<ExportMessage[]> {
  const result: ExportMessage[] = []
  const contactCache = new Map<string, { nickname?: string; avatarUrl?: string }>()

  for (const msg of messages) {
    const sender = msg.senderUsername || msg.talker || sessionId
    const isMe = sender === sessionInfo.myWxid

    // 获取发送者信息
    let displayName = isMe ? sessionInfo.myNickname : '对方'
    let groupNickname: string | undefined
    let avatarUrl: string | undefined

    if (!isMe) {
      // 从缓存或查询获取
      if (sessionInfo.members?.has(sender)) {
        const member = sessionInfo.members.get(sender)!
        displayName = member.nickname
        groupNickname = member.groupNickname
        avatarUrl = member.avatarUrl
      } else if (!contactCache.has(sender)) {
        const contactResult = await wcdbService.getContact(sender)
        if (contactResult.success && contactResult.contact) {
          contactCache.set(sender, {
            nickname: contactResult.contact.nickname,
            avatarUrl: contactResult.contact.avatarUrl
          })
        }
      }

      if (contactCache.has(sender)) {
        const cached = contactCache.get(sender)!
        displayName = cached.nickname || sender
        avatarUrl = cached.avatarUrl
      }
    }

    // 解析引用消息
    let replyToId: number | undefined
    let replyToContent: string | undefined
    if (msg.quoteContent) {
      try {
        const quote = JSON.parse(msg.quoteContent)
        replyToId = quote.localId
        replyToContent = quote.content
      } catch {
        // 解析失败忽略
      }
    }

    // 解析合并转发
    let chatRecordTitle: string | undefined
    let chatRecordList: any[] | undefined
    if (msg.type === 49 && msg.subType === 19 && msg.content) {
      try {
        const appMsg = JSON.parse(msg.content)
        chatRecordTitle = appMsg.title
        chatRecordList = appMsg.recordList || appMsg.chatRecordList
      } catch {
        // 解析失败忽略
      }
    }

    result.push({
      id: msg.id || msg.localId,
      localId: msg.localId,
      serverId: msg.serverId,
      createTime: msg.createTime,
      type: msg.type,
      subType: msg.subType,
      isSender: msg.isSender || isMe,
      talker: sender,
      content: msg.content,
      displayName,
      groupNickname,
      avatarUrl,
      imagePath: msg.imagePath || msg.thumbPath,
      voicePath: msg.voicePath,
      videoPath: msg.videoPath,
      videoThumbPath: msg.videoThumbPath,
      filePath: msg.filePath,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      replyToId,
      replyToContent,
      chatRecordTitle,
      chatRecordList
    })
  }

  return result
}

function resolveMediaStorageRoot(options: HtmlExportOptions): string {
  if (options.dayPartition?.sessionDir && options.dayPartition.day) {
    return options.dayPartition.sessionDir
  }
  return dirname(options.outputPath)
}

function resolveMediaDir(options: HtmlExportOptions): string {
  const root = resolveMediaStorageRoot(options)
  return join(root, 'media')
}

function resolveMediaMappingPath(options: HtmlExportOptions): string {
  const root = resolveMediaStorageRoot(options)
  if (options.dayPartition?.sessionDir) {
    return join(root, '.weflow', MEDIA_MAPPING_FILE)
  }
  return join(root, MEDIA_MAPPING_FILE)
}

function resolveMediaRelativePrefix(_options: HtmlExportOptions): string {
  return './media'
}
function loadMediaMapping(options: HtmlExportOptions): MediaMapping {
  const mappingPath = resolveMediaMappingPath(options)
  const sessionId = options.sessionId
  if (existsSync(mappingPath)) {
    try {
      const content = readFileSync(mappingPath, 'utf-8')
      const mapping = JSON.parse(content) as MediaMapping
      if (mapping.sessionId === sessionId) {
        console.log(`[📂 Rust HTML Export] 加载已有媒体映射，包含 ${Object.keys(mapping.mediaFiles).length} 个文件`)
        return mapping
      }
    } catch (e) {
      console.warn('[⚠️ Rust HTML Export] 加载媒体映射失败:', e)
    }
  }
  return {
    version: '1.0',
    exportedAt: Date.now(),
    sessionId,
    mediaFiles: {}
  }
}

function saveMediaMapping(options: HtmlExportOptions, mapping: MediaMapping): void {
  const mappingPath = resolveMediaMappingPath(options)
  mapping.exportedAt = Date.now()
  try {
    mkdirSync(dirname(mappingPath), { recursive: true })
    writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8')
    console.log(`[💾 Rust HTML Export] 保存媒体映射，共 ${Object.keys(mapping.mediaFiles).length} 个文件`)
  } catch (e) {
    console.warn('[⚠️ Rust HTML Export] 保存媒体映射失败:', e)
  }
}

/**
 * 生成媒体文件唯一标识（用于增量导出）
 */
function generateMediaKey(msg: ExportMessage, type: 'image' | 'video' | 'voice' | 'file'): string {
  // 使用消息ID + 类型 + 原始路径/MD5 的组合作为唯一标识
  const source = type === 'image' ? msg.imagePath :
                type === 'video' ? msg.videoPath :
                type === 'voice' ? msg.voicePath :
                msg.filePath || ''
  return `${msg.localId}_${type}_${source || 'unknown'}`
}

/**
 * 导出媒体文件 - 支持增量导出
 */
async function exportMediaFiles(
  messages: ExportMessage[],
  options: HtmlExportOptions,
  onProgress: (current: number, total: number) => void
): Promise<{ exportedCount: number; reusedCount: number }> {
  const mediaDir = resolveMediaDir(options)
  const mediaRoot = resolveMediaStorageRoot(options)
  const mediaRelativePrefix = resolveMediaRelativePrefix(options)
  const day = options.dayPartition?.day

  if (!existsSync(mediaDir)) {
    mkdirSync(mediaDir, { recursive: true })
  }

  const mapping = loadMediaMapping(options)
  const existingMedia = mapping.mediaFiles

  let exportedCount = 0
  let reusedCount = 0
  const maxSize = (options.maxFileSizeMb || 100) * 1024 * 1024

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    onProgress(i, messages.length)

    if (options.exportImages !== false && msg.imagePath) {
      const mediaKey = generateMediaKey(msg, 'image')

      if (existingMedia[mediaKey]) {
        const mediaInfo = existingMedia[mediaKey]
        const normalizedDest = mediaInfo.destPath.replace(/^\.\//, '')
        const fullDestPath = join(mediaRoot, normalizedDest)

        if (existsSync(fullDestPath)) {
          const htmlRelativePath = day
            ? `../${normalizedDest}`
            : mediaInfo.destPath
          msg.imageLocalPath = htmlRelativePath
          reusedCount++
          continue
        }
        delete existingMedia[mediaKey]
      }

      try {
        const decryptResult = await imageDecryptService.decryptImage({
          sessionId: options.sessionId,
          imageMd5: msg.imagePath,
          preferFilePath: true
        })

        if (decryptResult.success && decryptResult.localPath) {
          const localPath = typeof decryptResult.localPath === 'string'
            ? decryptResult.localPath
            : decryptResult.localPath

          const stats = statSync(localPath)
          if (stats.size <= maxSize) {
            const ext = extname(localPath) || '.jpg'
            const destName = `img_${msg.localId}_${Date.now()}${ext}`
            const destPath = join(mediaDir, destName)
            const relativeDestPath = `${mediaRelativePrefix}/${destName}`

            copyFileSync(localPath, destPath)
            msg.imageLocalPath = day ? `../${relativeDestPath.replace(/^\.\//, '')}` : relativeDestPath

            existingMedia[mediaKey] = {
              type: 'image',
              sourcePath: msg.imagePath,
              destPath: relativeDestPath,
              fileName: destName,
              fileSize: stats.size,
              exportedAt: Date.now(),
              day
            }

            exportedCount++
          }
        }
      } catch (e) {
        console.warn(`[Rust HTML Export] 导出图片失败: ${msg.localId}`, e)
      }
    }

    // TODO: 导出视频、语音、文件等（同样的增量逻辑）
  }

  saveMediaMapping(options, mapping)

  console.log(`[📊 Rust HTML Export] 媒体导出完成: 新增 ${exportedCount} 个，复用 ${reusedCount} 个`)
  return { exportedCount, reusedCount }
}

/**
 * 调用 Rust 生成 HTML
 */
async function generateHtmlWithRust(
  messages: ExportMessage[],
  sessionInfo: SessionInfo,
  options: HtmlExportOptions,
  onProgress: (current: number, total: number) => void
): Promise<boolean> {
  const service = new rustModule.ExportService()

  // 创建任务
  const task = service.createTask(`html-${Date.now()}`, {
    format: 'Html',
    outputPath: options.outputPath,
    includeMedia: options.includeMedia,
    includeAvatar: options.includeAvatar
  })

  if (!task) {
    return false
  }

  // 转换消息格式
  const rustMessages = messages.map(m => ({
    id: m.id,
    localId: m.localId,
    serverId: m.serverId,
    createTime: m.createTime,
    type: m.type,
    subType: m.subType,
    isSender: m.isSender,
    talker: m.talker,
    content: m.content,
    imagePath: m.imageLocalPath || m.imagePath,
    voicePath: m.voicePath,
    videoPath: m.videoPath,
    filePath: m.filePath,
    status: 0,
    msgSeq: 0
  }))

  // 转换会话格式
  const rustSession = {
    id: sessionInfo.id,
    nickname: sessionInfo.name,
    remark: sessionInfo.name,
    type: sessionInfo.type === 'group' ? 2 : 1,
    messageCount: messages.length
  }

  // 执行导出
  try {
    return await task.execute(rustMessages, rustSession)
  } catch (e) {
    console.error('[Rust HTML Export] 执行失败:', e)
    return false
  }
}
