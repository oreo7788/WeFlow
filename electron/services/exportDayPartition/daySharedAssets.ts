import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getDayHtmlPageInitScript, getVirtualScrollScript } from '../exportServiceUtils'

const INDEX_CSS = `:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --card: #ffffff;
  --text: #1f2329;
  --muted: #646a73;
  --border: #e5e6eb;
  --accent: #3370ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101114;
    --card: #1a1c21;
    --text: #f0f1f5;
    --muted: #a4a8b0;
    --border: #2b2f36;
    --accent: #4c82ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
header, main, footer {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 20px;
}
header h1 { margin: 0 0 8px; font-size: 28px; }
header p { margin: 0 0 16px; color: var(--muted); }
#daySearch, #messageSearch {
  width: 100%;
  max-width: 360px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-size: 14px;
  margin-top: 8px;
}
#dayList {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.day-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.day-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.day-card .date { font-size: 16px; font-weight: 600; }
.day-card .count, .day-card .media { font-size: 13px; color: var(--muted); }
footer {
  color: var(--muted);
  font-size: 13px;
  border-top: 1px solid var(--border);
}
.hidden { display: none !important; }
#messageSearchResults {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.message-search-item {
  display: block;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: inherit;
  text-decoration: none;
}
.message-search-item:hover { border-color: var(--accent); }
.message-search-item .meta { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.message-search-item .preview { font-size: 14px; }
`

const INDEX_JS = `(function () {
  var dayInput = document.getElementById('daySearch');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.day-card'));
  if (dayInput && cards.length > 0) {
    dayInput.addEventListener('input', function () {
      var keyword = String(dayInput.value || '').trim();
      cards.forEach(function (card) {
        var day = card.getAttribute('data-day') || '';
        var matched = !keyword || day.indexOf(keyword) !== -1;
        card.classList.toggle('hidden', !matched);
      });
    });
  }

  var messageInput = document.getElementById('messageSearch');
  var messageResults = document.getElementById('messageSearchResults');
  if (!messageInput || !messageResults) return;

  var indexEntries = [];
  fetch('.weflow/search-index.jsonl')
    .then(function (res) { return res.ok ? res.text() : ''; })
    .then(function (text) {
      indexEntries = String(text || '').split('\\n').filter(Boolean).map(function (line) {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter(Boolean);
    })
    .catch(function () { indexEntries = []; });

  var messageSearchTimer;
  messageInput.addEventListener('input', function () {
    clearTimeout(messageSearchTimer);
    messageSearchTimer = setTimeout(function () {
      var keyword = String(messageInput.value || '').trim().toLowerCase();
      messageResults.innerHTML = '';
      if (!keyword) return;
      var matched = indexEntries.filter(function (entry) {
        return String(entry.preview || '').toLowerCase().indexOf(keyword) !== -1;
      }).slice(0, 30);
      if (matched.length === 0) {
        messageResults.innerHTML = '<div class="message-search-item"><span class="preview">未找到匹配消息</span></div>';
        return;
      }
      matched.forEach(function (entry) {
        var link = document.createElement('a');
        link.className = 'message-search-item';
        link.href = entry.href || ('days/' + entry.day + '.html');
        link.innerHTML = '<div class="meta">' + (entry.day || '') + '</div><div class="preview">' + (entry.preview || '') + '</div>';
        messageResults.appendChild(link);
      });
    }, 250);
  });
})();`

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function writeIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8')
    if (hashContent(existing) === hashContent(content)) return
  }
  fs.writeFileSync(filePath, content, 'utf-8')
}

export async function ensureDayPartitionSharedAssets(
  sessionDir: string,
  loadExportHtmlStyles: () => string
): Promise<void> {
  const assetsDir = path.join(sessionDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })

  const exportCss = loadExportHtmlStyles()
  const exportJs = `${getVirtualScrollScript()}\n${getDayHtmlPageInitScript()}`

  writeIfChanged(path.join(assetsDir, 'export.css'), exportCss)
  writeIfChanged(path.join(assetsDir, 'export.js'), exportJs)
  writeIfChanged(path.join(assetsDir, 'index.css'), INDEX_CSS)
  writeIfChanged(path.join(assetsDir, 'index.js'), INDEX_JS)
}

export function buildDayExportScriptBlock(assetPrefix: string): string {
  return `<script src="${assetPrefix}assets/export.js"></script>`
}
