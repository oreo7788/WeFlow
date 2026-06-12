import * as fs from 'fs'
import { resolveDayHtmlAbsolutePath } from './dayRangeResolver'

export async function removeDayHtml(sessionDir: string, day: string, htmlPath?: string): Promise<void> {
  const targetPath = resolveDayHtmlAbsolutePath(sessionDir, day, htmlPath)
  if (!fs.existsSync(targetPath)) {
    const legacyPath = resolveDayHtmlAbsolutePath(sessionDir, day, `days/${day}.html`)
    if (fs.existsSync(legacyPath)) {
      await fs.promises.unlink(legacyPath)
    }
    return
  }
  await fs.promises.unlink(targetPath)
}
