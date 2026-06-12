import * as fs from 'fs'
import * as path from 'path'
import { escapeHtml } from '../exportServiceUtils'
import type { SessionExportManifest } from './dayManifestTypes'
import { resolveDayHtmlRelativePath, sortDayKeys } from './dayRangeResolver'

function formatUpdatedAt(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '未知'
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return '未知'
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  const h = `${date.getHours()}`.padStart(2, '0')
  const min = `${date.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

export function renderIndexHtml(manifest: SessionExportManifest): string {
  const dayKeys = sortDayKeys(Object.keys(manifest.days)).reverse()
  const totalDays = dayKeys.length
  const sessionName = escapeHtml(manifest.sessionName || manifest.sessionId)
  const updatedAt = formatUpdatedAt(manifest.updatedAt)

  const dayCards = dayKeys.map((day) => {
    const entry = manifest.days[day]
    const messageCount = Math.max(0, Math.floor(Number(entry?.messageCount || 0)))
    const mediaCount = Math.max(0, Math.floor(Number(entry?.mediaCount || 0)))
    const htmlPath = escapeHtml(entry?.htmlPath || resolveDayHtmlRelativePath(day))
    return `
    <a class="day-card" href="${htmlPath}" data-day="${escapeHtml(day)}">
      <span class="date">${escapeHtml(day)}</span>
      <span class="count">${messageCount} 条</span>
      <span class="media">${mediaCount} 个媒体</span>
    </a>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${sessionName} - 聊天记录总览</title>
  <link rel="stylesheet" href="assets/index.css" />
</head>
<body>
  <header>
    <h1>${sessionName}</h1>
    <p>共 ${totalDays} 天 · ${manifest.totalMessageCount} 条消息 · 更新于 ${updatedAt}</p>
    <input id="daySearch" type="search" placeholder="搜索日期..." autocomplete="off" />
    <input id="messageSearch" type="search" placeholder="搜索消息内容（跨天）..." autocomplete="off" />
    <div id="messageSearchResults"></div>
  </header>

  <main id="dayList">
    ${dayCards || '<p style="color: var(--muted);">暂无按天导出的聊天记录。</p>'}
  </main>

  <footer>
    <span>由 WeFlow 导出</span>
  </footer>

  <script src="assets/index.js"></script>
</body>
</html>
`
}

export async function writeIndexHtml(sessionDir: string, manifest: SessionExportManifest): Promise<string> {
  const indexPath = path.join(sessionDir, manifest.indexPath || 'index.html')
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.writeFileSync(indexPath, renderIndexHtml(manifest), 'utf-8')
  return indexPath
}
