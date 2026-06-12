import * as fs from 'fs'
import * as path from 'path'
import JSZip from 'jszip'
import type { SessionExportManifest } from './dayManifestTypes'
import { groupDayKeysByMonth, resolveDayHtmlAbsolutePath, resolveDayHtmlRelativePath, sortDayKeys } from './dayRangeResolver'

export interface DayArchiveResult {
  archivedMonths: string[]
  archiveFiles: string[]
}

function monthIsOlderThan(monthKey: string, keepRecentMonths: number, now = new Date()): boolean {
  const matched = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!matched) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const monthStart = new Date(year, month - 1, 1)
  const threshold = new Date(now.getFullYear(), now.getMonth() - keepRecentMonths, 1)
  return monthStart.getTime() < threshold.getTime()
}

async function zipDirectoryContents(zip: JSZip, sourceDir: string, zipPrefix: string): Promise<void> {
  if (!fs.existsSync(sourceDir)) return
  const stack: Array<{ abs: string; rel: string }> = [{ abs: sourceDir, rel: zipPrefix }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current.abs, { withFileTypes: true })
    for (const entry of entries) {
      const absPath = path.join(current.abs, entry.name)
      const relPath = path.posix.join(current.rel, entry.name)
      if (entry.isDirectory()) {
        stack.push({ abs: absPath, rel: relPath })
      } else if (entry.isFile()) {
        zip.file(relPath, fs.readFileSync(absPath))
      }
    }
  }
}

export async function archiveOldMonthPartitions(
  sessionDir: string,
  manifest: SessionExportManifest,
  options?: {
    keepRecentMonths?: number
    excludeDays?: string[]
  }
): Promise<DayArchiveResult> {
  const keepRecentMonths = Math.max(1, Math.floor(Number(options?.keepRecentMonths || 12)))
  const excludeSet = new Set(options?.excludeDays || [])
  const dayKeys = sortDayKeys(Object.keys(manifest.days || {}))
  const grouped = groupDayKeysByMonth(dayKeys)

  const archivedMonths: string[] = []
  const archiveFiles: string[] = []
  const archivesDir = path.join(sessionDir, 'archives')
  fs.mkdirSync(archivesDir, { recursive: true })

  for (const [monthKey, days] of Object.entries(grouped)) {
    if (!monthIsOlderThan(monthKey, keepRecentMonths)) continue
    if (days.some(day => excludeSet.has(day))) continue

    const allFresh = days.every(day => manifest.days[day]?.status === 'fresh')
    if (!allFresh) continue

    const archivePath = path.join(archivesDir, `${monthKey}.zip`)
    if (fs.existsSync(archivePath)) continue

    const zip = new JSZip()
    const [year, month] = monthKey.split('-')
    const dayHtmlDir = path.join(sessionDir, 'days', year, month)
    await zipDirectoryContents(zip, dayHtmlDir, path.posix.join('days', year, month))

    for (const day of days) {
      const legacyHtml = path.join(sessionDir, 'days', `${day}.html`)
      if (fs.existsSync(legacyHtml)) {
        zip.file(path.posix.join('days', `${day}.html`), fs.readFileSync(legacyHtml))
      }
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    fs.writeFileSync(archivePath, buffer)
    archivedMonths.push(monthKey)
    archiveFiles.push(archivePath)

    if (fs.existsSync(dayHtmlDir)) {
      fs.rmSync(dayHtmlDir, { recursive: true, force: true })
    }
    for (const day of days) {
      const htmlPath = resolveDayHtmlAbsolutePath(sessionDir, day, manifest.days[day]?.htmlPath || resolveDayHtmlRelativePath(day))
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath)
      const legacyHtml = path.join(sessionDir, 'days', `${day}.html`)
      if (fs.existsSync(legacyHtml)) fs.unlinkSync(legacyHtml)
    }
  }

  return { archivedMonths, archiveFiles }
}
