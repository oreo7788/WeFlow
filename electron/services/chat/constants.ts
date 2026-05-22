// 表情包下载缓存（模块级，跨 ChatService 实例共享）
export const emojiCache: Map<string, string> = new Map()
export const emojiDownloading: Map<string, Promise<string | null>> = new Map()

export const FRIEND_EXCLUDE_USERNAMES = new Set(['medianote', 'floatbottle', 'qmessage', 'qqmail', 'fmessage'])
