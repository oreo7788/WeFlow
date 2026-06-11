import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Rust 模块桥接
let rustModule: any = null
try {
  // 计算 rust 模块路径
  let rustPath: string
  if (__dirname.includes('dist-electron')) {
    // 打包后: dist-electron/services/ -> ../../rust
    rustPath = join(__dirname, '..', '..', 'rust')
  } else {
    // 开发环境: electron/services/ -> ../../rust
    rustPath = join(__dirname, '..', '..', 'rust')
  }

  // 检查路径是否存在
  if (!existsSync(rustPath)) {
    const cwdRustPath = join(process.cwd(), 'rust')
    if (existsSync(cwdRustPath)) {
      rustPath = cwdRustPath
    }
  }

  rustModule = require(rustPath)
  console.log('[🔥 Rust Export] 核心模块加载成功')
} catch (e) {
  console.log('[🔥 Rust Export] 模块加载失败:', (e as Error).message)
}

// 导出进度回调类型
export type ExportProgressCallback = (progress: {
  total: number
  current: number
  percentage: number
  stage: string
  currentItem?: string
}) => void

// 导出配置
export interface RustExportConfig {
  format: 'Html' | 'Json' | 'Csv' | 'Excel' | 'Txt' | 'ChatLab'
  outputPath: string
  includeMedia: boolean
  includeAvatar?: boolean
  dateRangeStart?: number
  dateRangeEnd?: number
  maxFileSizeMb?: number
  namingMode?: 'datetime' | 'sequential' | 'original'
}

// 消息类型
export interface RustMessage {
  id: number
  localId: number
  serverId?: string
  createTime: number
  type: number
  subType: number
  isSender: boolean
  talker: string
  content?: string
  imagePath?: string
  voicePath?: string
  videoPath?: string
  filePath?: string
  status: number
  msgSeq: number
}

// 会话类型
export interface RustSession {
  id: string
  nickname?: string
  remark?: string
  type: number
  messageCount: number
}

// 导出任务
let rustExportTask: any = null

/**
 * 检查 Rust 导出服务是否可用
 */
export function isRustExportAvailable(): boolean {
  return rustModule?.ExportService !== null && rustModule?.ExportService !== undefined
}

/**
 * 创建导出任务
 */
export function createRustExportTask(
  taskId: string,
  config: RustExportConfig
): { task: any; execute: (messages: RustMessage[], session: RustSession) => Promise<boolean> } | null {
  if (!isRustExportAvailable()) {
    console.log('[❌ Rust Export] ExportService 不可用')
    return null
  }

  try {
    const service = new rustModule.ExportService()
    const task = service.createTask(taskId, {
      format: config.format,
      outputPath: config.outputPath,
      includeMedia: config.includeMedia,
      includeAvatar: config.includeAvatar ?? false,
      dateRangeStart: config.dateRangeStart,
      dateRangeEnd: config.dateRangeEnd,
      maxFileSizeMb: config.maxFileSizeMb,
      namingMode: config.namingMode ?? 'datetime',
    })

    if (!task) {
      console.log('[❌ Rust Export] 创建任务失败')
      return null
    }

    return {
      task,
      execute: async (messages: RustMessage[], session: RustSession): Promise<boolean> => {
        const start = performance.now()
        console.log(`[🔥 Rust Export] 开始导出 ${messages.length} 条消息到 ${config.format}`)

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
          imagePath: m.imagePath,
          voicePath: m.voicePath,
          videoPath: m.videoPath,
          filePath: m.filePath,
          status: m.status,
          msgSeq: m.msgSeq,
        }))

        const rustSession = {
          id: session.id,
          nickname: session.nickname,
          remark: session.remark,
          type: session.type,
          messageCount: session.messageCount,
        }

        try {
          const result = await task.execute(rustMessages, rustSession)
          const duration = performance.now() - start
          console.log(`[✅ Rust Export] 导出完成: ${result}, 耗时 ${duration.toFixed(1)}ms`)
          return result
        } catch (e) {
          const duration = performance.now() - start
          console.log(`[❌ Rust Export] 导出失败: ${(e as Error).message}, 耗时 ${duration.toFixed(1)}ms`)
          return false
        }
      },
    }
  } catch (e) {
    console.log('[❌ Rust Export] 创建任务异常:', (e as Error).message)
    return null
  }
}

/**
 * 使用 Rust 导出 HTML
 */
export async function exportHtmlViaRust(
  messages: RustMessage[],
  session: RustSession,
  outputPath: string,
  includeMedia: boolean = true
): Promise<{ success: boolean; durationMs: number }> {
  const start = performance.now()

  const taskInfo = createRustExportTask(`html-${Date.now()}`, {
    format: 'Html',
    outputPath,
    includeMedia,
  })

  if (!taskInfo) {
    return { success: false, durationMs: 0 }
  }

  const success = await taskInfo.execute(messages, session)
  const durationMs = performance.now() - start

  return { success, durationMs }
}
