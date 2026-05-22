import { join, extname } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import { emojiCache, emojiDownloading } from './constants'
import type { Message } from './types'
import type { EmojiHost } from './emojiHost'

export class EmojiService {
  constructor(private readonly host: EmojiHost) {}

  getEmojiCacheDir(): string {
    return this.host.getEmojiCacheDir()
  }

  clearEmojiCacheDir(): { success: boolean; error?: string } {
    emojiCache.clear()
    emojiDownloading.clear()
    const emojiDir = this.getEmojiCacheDir()
    try {
      fs.rmSync(emojiDir, { recursive: true, force: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async downloadEmoji(cdnUrl: string, md5?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
    if (!cdnUrl) {
      return { success: false, error: '无效的 CDN URL' }
    }

    const cacheKey = md5 || this.hashString(cdnUrl)

    const cached = emojiCache.get(cacheKey)
    if (cached && existsSync(cached)) {
      return { success: true, localPath: cached }
    }

    const downloading = emojiDownloading.get(cacheKey)
    if (downloading) {
      const result = await downloading
      if (result) {
        return { success: true, localPath: result }
      }
      return { success: false, error: '下载失败' }
    }

    const cacheDir = this.getEmojiCacheDir()
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }

    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = join(cacheDir, `${cacheKey}${ext}`)
      if (existsSync(filePath)) {
        emojiCache.set(cacheKey, filePath)
        return { success: true, localPath: filePath }
      }
    }

    const downloadPromise = this.doDownloadEmoji(cdnUrl, cacheKey, cacheDir)
    emojiDownloading.set(cacheKey, downloadPromise)

    try {
      const localPath = await downloadPromise
      emojiDownloading.delete(cacheKey)

      if (localPath) {
        emojiCache.set(cacheKey, localPath)
        return { success: true, localPath }
      }
      return { success: false, error: '下载失败' }
    } catch (e) {
      console.error(`[ChatService] 表情包下载异常: url=${cdnUrl}, md5=${md5}`, e)
      emojiDownloading.delete(cacheKey)
      return { success: false, error: String(e) }
    }
  }

  async downloadEmojiFile(msg: Message): Promise<string | null> {
    if (!msg.emojiMd5) return null
    let url = msg.emojiCdnUrl

    if (!url && msg.emojiEncryptUrl) {
      console.warn('[ChatService] Emoji has only encryptUrl:', msg.emojiMd5)
    }

    if (!url) {
      await this.host.repairEmoticonFallback(msg)
      url = msg.emojiCdnUrl
    }

    if (!url) return null

    const result = await this.downloadEmoji(url, msg.emojiMd5)
    if (result.success && result.localPath) {
      return result.localPath
    }
    return null
  }

  private doDownloadEmoji(url: string, cacheKey: string, cacheDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      const protocol = url.startsWith('https') ? https : http

      const request = protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            this.doDownloadEmoji(redirectUrl, cacheKey, cacheDir).then(resolve)
            return
          }
        }

        if (response.statusCode !== 200) {
          resolve(null)
          return
        }

        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.length === 0) {
            resolve(null)
            return
          }

          const ext = this.detectImageExtension(buffer) || this.getExtFromUrl(url) || '.gif'
          const filePath = join(cacheDir, `${cacheKey}${ext}`)

          try {
            writeFileSync(filePath, buffer)
            resolve(filePath)
          } catch {
            resolve(null)
          }
        })
        response.on('error', () => resolve(null))
      })

      request.on('error', () => resolve(null))
      request.setTimeout(10000, () => {
        request.destroy()
        resolve(null)
      })
    })
  }

  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null

    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return '.gif'
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return '.png'
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return '.jpg'
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }

    return null
  }

  private getExtFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const ext = extname(pathname).toLowerCase()
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return ext
      }
    } catch { }
    return null
  }

  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }
}
