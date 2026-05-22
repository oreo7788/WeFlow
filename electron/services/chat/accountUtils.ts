/**
 * 清理账号目录名（与 ChatService 历史逻辑一致）
 */
export function cleanAccountDirName(dirName: string): string {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    if (match) return match[1]
    return trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  const cleaned = suffixMatch ? suffixMatch[1] : trimmed

  return cleaned
}
