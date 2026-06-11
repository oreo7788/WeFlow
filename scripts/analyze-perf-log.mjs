#!/usr/bin/env node
/**
 * Summarize WeFlow perf.log for baseline comparison.
 *
 * Usage:
 *   node scripts/analyze-perf-log.mjs
 *   node scripts/analyze-perf-log.mjs --log /path/to/perf.log
 *   node scripts/analyze-perf-log.mjs --slow 100
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function parseArgs(argv) {
  const args = { log: null, slow: 100, top: 12 }
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--log') {
      args.log = argv[i + 1] || null
      i += 1
      continue
    }
    if (token === '--slow') {
      args.slow = Number(argv[i + 1] || 100)
      i += 1
      continue
    }
    if (token === '--top') {
      args.top = Number(argv[i + 1] || 12)
      i += 1
    }
  }
  return args
}

function resolveDefaultLogPath() {
  const candidates = [
    join(process.cwd(), 'logs', 'perf.log'),
    join(tmpdir(), 'weflow-logs', 'perf.log')
  ]
  if (process.env.WCDB_LOG_DIR) {
    candidates.unshift(join(process.env.WCDB_LOG_DIR, 'logs', 'perf.log'))
  }
  return candidates.find((path) => existsSync(path)) || candidates[0]
}

function parsePerfLine(line) {
  const marker = line.indexOf('[perf]')
  if (marker < 0) return null

  const payload = line.slice(marker + '[perf]'.length).trim()
  const fields = {}
  for (const part of payload.split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    const raw = part.slice(eq + 1)
    fields[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
  }

  if (!fields.area || !fields.action || !Number.isFinite(fields.durationMs)) return null
  return fields
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarizeEntries(entries) {
  const durations = entries.map((entry) => entry.durationMs)
  const total = durations.reduce((sum, value) => sum + value, 0)
  return {
    count: entries.length,
    totalMs: Math.round(total * 100) / 100,
    avgMs: Math.round((total / durations.length) * 100) / 100,
    p50Ms: Math.round(percentile(durations, 50) * 100) / 100,
    p95Ms: Math.round(percentile(durations, 95) * 100) / 100,
    maxMs: Math.round(Math.max(...durations) * 100) / 100
  }
}

function formatSummaryRow(key, summary) {
  return [
    key.padEnd(42),
    String(summary.count).padStart(5),
    String(summary.avgMs).padStart(8),
    String(summary.p50Ms).padStart(8),
    String(summary.p95Ms).padStart(8),
    String(summary.maxMs).padStart(8),
    String(summary.totalMs).padStart(10)
  ].join('  ')
}

function main() {
  const args = parseArgs(process.argv)
  const logPath = args.log || resolveDefaultLogPath()

  if (!existsSync(logPath)) {
    console.error(`perf log not found: ${logPath}`)
    console.error('Run the app in dev mode or set WEFLOW_PERF_LOG=1, then reproduce chat loading.')
    process.exit(1)
  }

  const raw = readFileSync(logPath, 'utf8')
  const entries = raw
    .split('\n')
    .map(parsePerfLine)
    .filter(Boolean)

  if (entries.length === 0) {
    console.error(`No perf entries found in ${logPath}`)
    process.exit(1)
  }

  const grouped = new Map()
  for (const entry of entries) {
    const key = `${entry.area}.${entry.action}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(entry)
  }

  const ranked = [...grouped.entries()]
    .map(([key, groupEntries]) => ({ key, summary: summarizeEntries(groupEntries) }))
    .sort((left, right) => right.summary.totalMs - left.summary.totalMs)

  console.log(`Perf baseline summary`)
  console.log(`Log: ${logPath}`)
  console.log(`Entries: ${entries.length}`)
  console.log('')
  console.log([
    'action'.padEnd(42),
    'count'.padStart(5),
    'avgMs'.padStart(8),
    'p50Ms'.padStart(8),
    'p95Ms'.padStart(8),
    'maxMs'.padStart(8),
    'totalMs'.padStart(10)
  ].join('  '))
  console.log('-'.repeat(96))

  for (const item of ranked.slice(0, args.top)) {
    console.log(formatSummaryRow(item.key, item.summary))
  }

  const slowEntries = entries
    .filter((entry) => entry.durationMs >= args.slow)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, args.top)

  if (slowEntries.length > 0) {
    console.log('')
    console.log(`Slowest events (>= ${args.slow}ms):`)
    for (const entry of slowEntries) {
      const extras = Object.entries(entry)
        .filter(([key]) => !['area', 'action', 'durationMs'].includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      console.log(`- ${entry.area}.${entry.action} ${entry.durationMs}ms ${extras}`.trim())
    }
  }
}

main()
