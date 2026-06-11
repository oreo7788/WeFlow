import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export type LogChannel = 'wcdb' | 'image-decrypt' | 'video' | 'app' | 'perf'
export type LogLevel = 'info' | 'warn' | 'error'

const CHANNEL_FILES: Record<LogChannel, string> = {
  wcdb: 'wcdb.log',
  'image-decrypt': 'image-decrypt.log',
  video: 'video.log',
  app: 'app.log',
  perf: 'perf.log',
}

const ERROR_LOG = 'error.log'

class FileLogService {
  private userDataPath: string | null = null
  private logEnabled = false
  private lastResolvedLogDir: string | null = null

  setUserDataPath(path: string): void {
    this.userDataPath = path
  }

  setLogEnabled(enabled: boolean): void {
    this.logEnabled = enabled
  }

  isLogEnabled(): boolean {
    if (process.env.WCDB_LOG_ENABLED === '1') return true
    return this.logEnabled
  }

  resolveLogDirCandidates(): string[] {
    const candidates: string[] = []
    if (this.userDataPath) candidates.push(join(this.userDataPath, 'logs'))
    if (process.env.WCDB_LOG_DIR) candidates.push(join(process.env.WCDB_LOG_DIR, 'logs'))
    candidates.push(join(process.cwd(), 'logs'))
    candidates.push(join(tmpdir(), 'weflow-logs'))
    return Array.from(new Set(candidates))
  }

  resolveLogDir(): string {
    if (this.lastResolvedLogDir && existsSync(this.lastResolvedLogDir)) {
      return this.lastResolvedLogDir
    }

    for (const dir of this.resolveLogDirCandidates()) {
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        this.lastResolvedLogDir = dir
        return dir
      } catch {
        // try next candidate
      }
    }

    const fallback = join(process.cwd(), 'logs')
    try {
      if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true })
    } catch {
      // ignore
    }
    this.lastResolvedLogDir = fallback
    return fallback
  }

  getLogDir(): string {
    return this.resolveLogDir()
  }

  getLogFilePath(channel: LogChannel | 'error'): string {
    const file = channel === 'error' ? ERROR_LOG : CHANNEL_FILES[channel]
    return join(this.resolveLogDir(), file)
  }

  inferLevel(message: string): LogLevel {
    const lower = message.toLowerCase()
    if (
      lower.includes('exception') ||
      lower.includes(' failed') ||
      lower.startsWith('failed') ||
      /\berror\b/.test(lower) ||
      lower.includes(' giving up')
    ) {
      return 'error'
    }
    if (lower.includes('warn')) return 'warn'
    return 'info'
  }

  write(
    channel: LogChannel,
    message: string,
    options?: { level?: LogLevel; force?: boolean; includeTimestamp?: boolean }
  ): void {
    const { force = false, includeTimestamp = true } = options || {}
    const level = options?.level ?? this.inferLevel(message)

    if (!force && !this.isLogEnabled() && level !== 'error') return

    const line = includeTimestamp
      ? `[${new Date().toISOString()}] ${message}`
      : message
    const content = line.endsWith('\n') ? line : `${line}\n`

    try {
      const logDir = this.resolveLogDir()
      appendFileSync(join(logDir, CHANNEL_FILES[channel]), content, 'utf8')

      if (level === 'error') {
        appendFileSync(join(logDir, ERROR_LOG), `[${channel}] ${content}`, 'utf8')
      }
    } catch (e) {
      console.error(`[FileLogService] write failed channel=${channel}:`, e)
    }
  }

  readAll(): string {
    const logDir = this.resolveLogDir()
    const parts: string[] = []
    const files = [...Object.values(CHANNEL_FILES), ERROR_LOG]

    for (const file of files) {
      const filePath = join(logDir, file)
      if (!existsSync(filePath)) continue
      try {
        const content = readFileSync(filePath, 'utf8').trim()
        if (!content) continue
        parts.push(`=== ${file} ===\n${content}`)
      } catch {
        // ignore unreadable file
      }
    }

    return parts.join('\n\n')
  }

  clearAll(): void {
    const logDir = this.resolveLogDir()
    const files = [...Object.values(CHANNEL_FILES), ERROR_LOG]

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }

    for (const file of files) {
      try {
        writeFileSync(join(logDir, file), '', 'utf8')
      } catch {
        // ignore
      }
    }
  }
}

export const fileLogService = new FileLogService()
