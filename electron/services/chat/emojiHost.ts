import type { Message } from './types'

export interface EmojiHost {
  getEmojiCacheDir(): string
  repairEmoticonFallback(msg: Message): Promise<void>
}
