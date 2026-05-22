import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import * as path from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { wcdbService } from '../wcdbService'
import { cleanAccountDirName } from './accountUtils'
import { buildIdentityKeys } from './messageRowUtils'
import { getRowField } from './messageRowUtils'
import {
  cleanUtf16,
  compactEncodedPayload,
  decodeBinaryContent,
  decodeHtmlEntities,
  decodeMaybeCompressed,
  decodeMessageContent,
  looksLikeBase64,
  looksLikeHex,
  parseMessageContent,
  parseType49Message,
  stripSenderPrefix,
  extractXmlValue
} from './messageParsing'
import { normalizeTimestampSeconds, toSafeInt, toSafeNumber } from './timeUtils'
import type {
  Message,
  MyFootprintData,
  MyFootprintDiagnostics,
  MyFootprintMentionGroup,
  MyFootprintMentionItem,
  MyFootprintPrivateSegment,
  MyFootprintPrivateSession,
  MyFootprintSummary
} from './types'
import type { MyFootprintHost } from './myFootprintHost'

export class MyFootprintService {
  constructor(private readonly host: MyFootprintHost) {}

async getMyFootprintStats(
    beginTimestamp: number,
    endTimestamp: number,
    options?: {
      myWxid?: string
      privateSessionIds?: string[]
      groupSessionIds?: string[]
      mentionLimit?: number
      privateLimit?: number
      mentionMode?: 'text_at_me' | string
    }
  ): Promise<{ success: boolean; data?: MyFootprintData; error?: string }> {
    try {
      const connectResult = await this.host.ensureConnected()
      if (!connectResult.success) {
        return { success: false, error: connectResult.error || '数据库未连接' }
      }

      const begin = normalizeTimestampSeconds(beginTimestamp)
      const end = normalizeTimestampSeconds(endTimestamp)
      const normalizedEnd = begin > 0 && end > 0 && end < begin ? begin : end
      const mentionLimitRaw = Number(options?.mentionLimit ?? 0)
      const privateLimitRaw = Number(options?.privateLimit ?? 0)
      const mentionLimit = Number.isFinite(mentionLimitRaw) && mentionLimitRaw >= 0
        ? Math.floor(mentionLimitRaw)
        : 0
      const privateLimit = Number.isFinite(privateLimitRaw) && privateLimitRaw >= 0
        ? Math.floor(privateLimitRaw)
        : 0

      let myWxid = String(options?.myWxid || '').trim()
      if (!myWxid) {
        myWxid = String(this.host.getMyWxidCleaned() || '').trim()
      }
      if (!myWxid) {
        return { success: false, error: '未识别当前账号 wxid' }
      }

      let privateSessionIds = Array.isArray(options?.privateSessionIds)
        ? options!.privateSessionIds!.map((value) => String(value || '').trim()).filter(Boolean)
        : []
      let groupSessionIds = Array.isArray(options?.groupSessionIds)
        ? options!.groupSessionIds!.map((value) => String(value || '').trim()).filter(Boolean)
        : []
      const privateSessionLocalTypeMap = new Map<string, number>()
      const hasExplicitGroupScope = Array.isArray(options?.groupSessionIds)
        && options!.groupSessionIds!.some((value) => String(value || '').trim().length > 0)

      if (privateSessionIds.length === 0 && groupSessionIds.length === 0) {
        const sessionsResult = await wcdbService.getSessions()
        if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) {
          return { success: false, error: sessionsResult.error || '读取会话列表失败' }
        }
        const openimLocalTypeMap = await this.host.loadContactLocalTypeMapForEnterpriseOpenim(
          (sessionsResult.sessions as Array<Record<string, any>>).map((session) => String(session.username || session.user_name || '').trim())
        )
        for (const session of sessionsResult.sessions as Array<Record<string, any>>) {
          const sessionId = String(session.username || session.user_name || '').trim()
          if (!sessionId) continue
          let sessionLocalType = this.host.getSessionLocalType(session)
          if (!Number.isFinite(sessionLocalType) && this.host.isEnterpriseOpenimUsername(sessionId)) {
            sessionLocalType = openimLocalTypeMap.get(sessionId)
          }
          if (typeof sessionLocalType === 'number' && Number.isFinite(sessionLocalType)) {
            privateSessionLocalTypeMap.set(sessionId, sessionLocalType)
          }
          const sessionLastTs = normalizeTimestampSeconds(
            Number(session.lastTimestamp || session.sortTimestamp || 0)
          )
          if (sessionId.endsWith('@chatroom')) {
            groupSessionIds.push(sessionId)
          } else {
            if (!this.host.shouldKeepSession(sessionId, sessionLocalType)) continue
            if (begin > 0 && sessionLastTs > 0 && sessionLastTs < begin) continue
            privateSessionIds.push(sessionId)
          }
        }
      }

      const unresolvedOpenimPrivateSessionIds = privateSessionIds.filter((value) =>
        this.host.isEnterpriseOpenimUsername(value) && !privateSessionLocalTypeMap.has(value)
      )
      if (unresolvedOpenimPrivateSessionIds.length > 0) {
        const fallbackMap = await this.host.loadContactLocalTypeMapForEnterpriseOpenim(unresolvedOpenimPrivateSessionIds)
        for (const [username, localType] of fallbackMap.entries()) {
          privateSessionLocalTypeMap.set(username, localType)
        }
      }

      privateSessionIds = Array.from(new Set(
        privateSessionIds
          .map((value) => String(value || '').trim())
          .filter((value) => value && !value.endsWith('@chatroom') && this.host.shouldKeepSession(value, privateSessionLocalTypeMap.get(value)))
      ))
      groupSessionIds = Array.from(new Set(
        groupSessionIds
          .map((value) => String(value || '').trim())
          .filter((value) => value && value.endsWith('@chatroom'))
      ))
      if (!hasExplicitGroupScope) {
        groupSessionIds = await this.resolveMyFootprintGroupSessionIds(groupSessionIds, begin, normalizedEnd)
      }

      privateSessionIds = await this.filterMyFootprintPrivateSessions(privateSessionIds)

      let data: MyFootprintData | null = null
      const effectivePrivateLimit = privateLimit
      // native 候选上限：0 表示不截断候选，确保前端 source 二次过滤有完整输入
      const nativeMentionCandidateLimit = 0
      let nativePasses = 0
      const candidateLimitUsed = nativeMentionCandidateLimit
      let nativeGroupChunks = 0

      const runNativePass = async (passOptions: {
        label: string
        passPrivateSessionIds: string[]
        passGroupSessionIds: string[]
        candidateLimit: number
        passPrivateLimit: number
      }): Promise<MyFootprintData> => {
        nativePasses += 1
        const nativeResult = await wcdbService.getMyFootprintStats({
          beginTimestamp: begin,
          endTimestamp: normalizedEnd,
          myWxid,
          privateSessionIds: passOptions.passPrivateSessionIds,
          groupSessionIds: passOptions.passGroupSessionIds,
          mentionLimit: passOptions.candidateLimit,
          privateLimit: passOptions.passPrivateLimit,
          mentionMode: options?.mentionMode || 'text_at_me'
        })
        if (!nativeResult.success || !nativeResult.data) {
          throw new Error(nativeResult.error || '获取我的足迹统计失败')
        }
        const normalized = this.normalizeMyFootprintData(nativeResult.data)
        return normalized
      }

      const runGroupPasses = async (targetGroupSessionIds: string[]): Promise<{ raw: MyFootprintData | null; chunks: number }> => {
        if (!Array.isArray(targetGroupSessionIds) || targetGroupSessionIds.length === 0) {
          return { raw: null, chunks: 0 }
        }
        const singleGroupThresholdRaw = Number(process.env.WEFLOW_MY_FOOTPRINT_SINGLE_GROUP_THRESHOLD || 40)
        const singleGroupThreshold = Number.isFinite(singleGroupThresholdRaw) && singleGroupThresholdRaw >= 1
          ? Math.floor(singleGroupThresholdRaw)
          : 40

        let aggregated: MyFootprintData | null = null
        let chunks = 0
        if (targetGroupSessionIds.length <= singleGroupThreshold) {
          chunks = targetGroupSessionIds.length
          for (const sessionId of targetGroupSessionIds) {
            const chunkRaw = await runNativePass({
              label: `group-single:${sessionId}`,
              passPrivateSessionIds: [],
              passGroupSessionIds: [sessionId],
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            aggregated = aggregated
              ? this.mergeMyFootprintMentionResult(aggregated, chunkRaw)
              : chunkRaw
          }
        } else {
          const groupChunks = splitGroupSessionsForNative(targetGroupSessionIds)
          chunks = groupChunks.length
          for (const chunk of groupChunks) {
            const chunkRaw = await runNativePass({
              label: `group-chunk:${chunk[0] || ''}..(${chunk.length})`,
              passPrivateSessionIds: [],
              passGroupSessionIds: chunk,
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            aggregated = aggregated
              ? this.mergeMyFootprintMentionResult(aggregated, chunkRaw)
              : chunkRaw
          }
        }
        return { raw: aggregated, chunks }
      }

      const splitGroupSessionsForNative = (sessionIds: string[]): string[][] => {
        const normalized = Array.from(new Set(
          (sessionIds || [])
            .map((value) => String(value || '').trim())
            .filter((value) => value.endsWith('@chatroom'))
        ))
        if (normalized.length === 0) return []

        // 规避 native options_json 可能存在的固定缓冲上限：按 payload 字节安全分块。
        const maxBytesRaw = Number(process.env.WEFLOW_MY_FOOTPRINT_GROUP_OPTIONS_MAX_BYTES || 900)
        const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw >= 512
          ? Math.floor(maxBytesRaw)
          : 900
        const estimateBytes = (groups: string[]): number => Buffer.byteLength(JSON.stringify({
          begin,
          end: normalizedEnd,
          my_wxid: myWxid,
          private_session_ids: [],
          group_session_ids: groups,
          mention_limit: candidateLimitUsed,
          private_limit: 0,
          mention_mode: options?.mentionMode || 'text_at_me'
        }), 'utf8')

        const chunks: string[][] = []
        let current: string[] = []
        for (const sessionId of normalized) {
          if (current.length === 0) {
            current.push(sessionId)
            continue
          }
          const next = [...current, sessionId]
          if (estimateBytes(next) > maxBytes) {
            chunks.push(current)
            current = [sessionId]
          } else {
            current = next
          }
        }
        if (current.length > 0) chunks.push(current)
        return chunks
      }

      let privateNativeRaw: MyFootprintData | null = null
      let mentionNativeRaw: MyFootprintData | null = null

      if (privateSessionIds.length > 0) {
        privateNativeRaw = await runNativePass({
          label: 'private',
          passPrivateSessionIds: privateSessionIds,
          passGroupSessionIds: [],
          candidateLimit: 0,
          passPrivateLimit: effectivePrivateLimit
        })
      }

      if (groupSessionIds.length > 0) {
        const firstPass = await runGroupPasses(groupSessionIds)
        mentionNativeRaw = firstPass.raw
        nativeGroupChunks = firstPass.chunks

        if ((mentionNativeRaw?.mentions.length || 0) === 0) {
          const probeIndexes = Array.from(new Set([
            0,
            Math.floor(groupSessionIds.length / 2),
            groupSessionIds.length - 1
          ])).filter((index) => index >= 0 && index < groupSessionIds.length)
          let probeHit = false
          for (const index of probeIndexes) {
            const sessionId = groupSessionIds[index]
            const probeRaw = await runNativePass({
              label: `group-probe:${sessionId}`,
              passPrivateSessionIds: [],
              passGroupSessionIds: [sessionId],
              candidateLimit: candidateLimitUsed,
              passPrivateLimit: 0
            })
            if (probeRaw.mentions.length > 0 || probeRaw.summary.mention_count > 0) {
              probeHit = true
              break
            }
          }

          if (probeHit) {
            await wcdbService.getSessions().catch(() => ({ success: false }))
            const retryPass = await runGroupPasses(groupSessionIds)
            mentionNativeRaw = retryPass.raw
            nativeGroupChunks = retryPass.chunks
          }
        }
      }

      let nativeRaw = privateNativeRaw || mentionNativeRaw || this.normalizeMyFootprintData({})
      if (privateNativeRaw && mentionNativeRaw) {
        nativeRaw = this.mergeMyFootprintMentionResult(privateNativeRaw, mentionNativeRaw)
      }

      data = this.filterMyFootprintMentionsBySource(nativeRaw, myWxid, mentionLimit)

      if (privateSessionIds.length > 0 && data.private_segments.length === 0) {
        const privateSegments = await this.rebuildMyFootprintPrivateSegments({
          begin,
          end: normalizedEnd,
          myWxid,
          privateSessionIds
        })
        if (privateSegments.length > 0) {
          data = {
            ...data,
            private_segments: privateSegments
          }
        }
      }

      if (data.mentions.length === 0) {
        if (this.shouldRunMyFootprintHeavyDebug()) {
          const privatePassRawMentions = privateNativeRaw?.mentions.length || 0
          const mentionPassRawMentions = mentionNativeRaw?.mentions.length || 0
          console.warn(
            `[MyFootprint][diag] zero filtered mentions begin=${begin} end=${normalizedEnd} groups=${groupSessionIds.length} raw=${nativeRaw.mentions.length} splitRaw(private=${privatePassRawMentions},group=${mentionPassRawMentions}) passes=${nativePasses} groupChunks=${nativeGroupChunks}`
          )
          await this.printMyFootprintNativeLogs('zero_filtered_mentions')
          await this.logMyFootprintNativeQuickProbe({
            begin,
            end: normalizedEnd,
            myWxid,
            groupSessionIds,
            mentionMode: options?.mentionMode || 'text_at_me'
          })
          await this.logMyFootprintZeroMentionDebug({
            begin,
            end: normalizedEnd,
            myWxid,
            groupSessionIds,
            nativeData: nativeRaw
          })
        }
      }

      const enriched = await this.enrichMyFootprintData(data)
      return { success: true, data: enriched }
    } catch (error) {
      console.error('[ChatService] 获取我的足迹统计失败:', error)
      return { success: false, error: String(error) }
    }
  }

async logMyFootprintNativeQuickProbe(params: {
    begin: number
    end: number
    myWxid: string
    groupSessionIds: string[]
    mentionMode: string
  }): Promise<void> {
    try {
      const groups = Array.from(new Set(
        (params.groupSessionIds || [])
          .map((value) => String(value || '').trim())
          .filter((value) => value.endsWith('@chatroom'))
      ))
      if (groups.length === 0) {
        console.warn('[MyFootprint][native-quick] skipped: no groups')
        return
      }
      const indices = Array.from(new Set([
        0,
        Math.floor(groups.length / 2),
        groups.length - 1
      ])).filter((index) => index >= 0 && index < groups.length)

      for (const index of indices) {
        const sessionId = groups[index]
        const result = await wcdbService.getMyFootprintStats({
          beginTimestamp: params.begin,
          endTimestamp: params.end,
          myWxid: params.myWxid,
          privateSessionIds: [],
          groupSessionIds: [sessionId],
          mentionLimit: 0,
          privateLimit: 0,
          mentionMode: params.mentionMode
        })
        if (!result.success || !result.data) {
          console.warn(
            `[MyFootprint][native-quick][${index + 1}/${groups.length}][${sessionId}] fail err=${result.error || 'unknown'}`
          )
          continue
        }
        const raw = this.normalizeMyFootprintData(result.data)
        console.warn(
          `[MyFootprint][native-quick][${index + 1}/${groups.length}][${sessionId}] mentions=${raw.mentions.length} mentionGroups=${raw.mention_groups.length} summaryMention=${raw.summary.mention_count} diagScanned=${raw.diagnostics.scanned_dbs} diagElapsed=${raw.diagnostics.elapsed_ms}`
        )
      }
    } catch (error) {
      console.warn('[MyFootprint][native-quick] exception:', error)
    }
  }

async rebuildMyFootprintPrivateSegments(params: {
    begin: number
    end: number
    myWxid: string
    privateSessionIds: string[]
  }): Promise<MyFootprintPrivateSegment[]> {
    const sessionGapSeconds = 10 * 60
    const segments: MyFootprintPrivateSegment[] = []

    type WorkingSegment = {
      segment_index: number
      start_ts: number
      end_ts: number
      incoming_count: number
      outgoing_count: number
      first_incoming_ts: number
      first_reply_ts: number
      anchor_local_id: number
      anchor_create_time: number
      latest_local_id: number
      latest_create_time: number
    }

    for (const sessionId of params.privateSessionIds) {
      const cursorResult = await wcdbService.openMessageCursorLite(
        sessionId,
        360,
        true,
        params.begin,
        params.end
      )
      if (!cursorResult.success || !cursorResult.cursor) continue

      let segmentCursor = 0
      let active: WorkingSegment | null = null
      let lastMessageTs = 0
      const commit = () => {
        if (!active) return
        const startTs = active.start_ts > 0 ? active.start_ts : active.anchor_create_time
        const endTs = active.end_ts > 0 ? active.end_ts : startTs
        const incoming = Math.max(0, active.incoming_count)
        const outgoing = Math.max(0, active.outgoing_count)
        const messageCount = incoming + outgoing
        if (startTs > 0 && messageCount > 0) {
          segments.push({
            session_id: sessionId,
            segment_index: active.segment_index,
            start_ts: startTs,
            end_ts: endTs,
            duration_sec: Math.max(0, endTs - startTs),
            incoming_count: incoming,
            outgoing_count: outgoing,
            message_count: messageCount,
            replied: incoming > 0 && outgoing > 0,
            first_incoming_ts: active.first_incoming_ts,
            first_reply_ts: active.first_reply_ts,
            latest_ts: endTs,
            anchor_local_id: active.anchor_local_id,
            anchor_create_time: startTs
          })
        }
        active = null
      }

      let hasMore = true
      try {
        while (hasMore) {
          const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
          if (!batchResult.success || !Array.isArray(batchResult.rows)) break
          hasMore = Boolean(batchResult.hasMore)

          for (const row of batchResult.rows as Array<Record<string, any>>) {
            const createTime = toSafeInt(row.create_time, 0)
            const localId = toSafeInt(row.local_id, 0)
            const isSend = this.resolveFootprintRowIsSend(row, params.myWxid)

            if (createTime > 0) {
              const needNew = !active || (lastMessageTs > 0 && createTime - lastMessageTs > sessionGapSeconds)
              if (needNew) {
                commit()
                segmentCursor += 1
                active = {
                  segment_index: segmentCursor,
                  start_ts: createTime,
                  end_ts: createTime,
                  incoming_count: 0,
                  outgoing_count: 0,
                  first_incoming_ts: 0,
                  first_reply_ts: 0,
                  anchor_local_id: localId,
                  anchor_create_time: createTime,
                  latest_local_id: localId,
                  latest_create_time: createTime
                }
              }
            } else if (!active) {
              segmentCursor += 1
              active = {
                segment_index: segmentCursor,
                start_ts: 0,
                end_ts: 0,
                incoming_count: 0,
                outgoing_count: 0,
                first_incoming_ts: 0,
                first_reply_ts: 0,
                anchor_local_id: localId,
                anchor_create_time: 0,
                latest_local_id: localId,
                latest_create_time: 0
              }
            }

            if (isSend) {
              if (active) {
                active.outgoing_count += 1
                if (
                  createTime > 0
                  && active.first_incoming_ts > 0
                  && createTime >= active.first_incoming_ts
                  && active.first_reply_ts <= 0
                ) {
                  active.first_reply_ts = createTime
                }
              }
            } else if (active) {
              active.incoming_count += 1
              if (active.first_incoming_ts <= 0 || (createTime > 0 && createTime < active.first_incoming_ts)) {
                active.first_incoming_ts = createTime
              }
            }

            if (active && createTime > 0) {
              active.end_ts = createTime
              active.latest_create_time = createTime
              active.latest_local_id = localId
              lastMessageTs = createTime
            }
          }
        }
      } finally {
        await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
      }

      commit()
    }

    return segments.sort((a, b) => {
      if (a.start_ts !== b.start_ts) return a.start_ts - b.start_ts
      if (a.session_id !== b.session_id) return a.session_id.localeCompare(b.session_id)
      return a.segment_index - b.segment_index
    })
  }

async exportMyFootprint(
    beginTimestamp: number,
    endTimestamp: number,
    format: 'csv' | 'json',
    filePath: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const normalizedFormat = String(format || '').toLowerCase() === 'csv' ? 'csv' : 'json'
      const targetPath = String(filePath || '').trim()
      if (!targetPath) {
        return { success: false, error: '导出路径不能为空' }
      }

      const statsResult = await this.getMyFootprintStats(beginTimestamp, endTimestamp)
      if (!statsResult.success || !statsResult.data) {
        return { success: false, error: statsResult.error || '导出前获取统计失败' }
      }

      mkdirSync(dirname(targetPath), { recursive: true })
      if (normalizedFormat === 'json') {
        writeFileSync(targetPath, JSON.stringify(statsResult.data, null, 2), 'utf-8')
      } else {
        const csv = this.buildMyFootprintCsv(statsResult.data)
        writeFileSync(targetPath, `\uFEFF${csv}`, 'utf-8')
      }

      return { success: true, filePath: targetPath }
    } catch (error) {
      console.error('[ChatService] 导出我的足迹失败:', error)
      return { success: false, error: String(error) }
    }
  }
resolveFootprintRowIsSend(row: Record<string, any>, myWxid: string): boolean {
    const raw = row.computed_is_send ?? row.is_send
    if (raw === 1 || raw === '1' || raw === true || raw === 'true') return true
    if (raw === 0 || raw === '0' || raw === false || raw === 'false') return false
    const senderUsername = String(row.sender_username || row.senderUsername || '').trim()
    return Boolean(senderUsername && myWxid && senderUsername === myWxid)
  }

splitAtUserList(raw: string): string[] {
    const tokens = String(raw || '')
      .split(/[,\s;|]+/g)
      .map((token) => token.trim().replace(/^@+/, '').replace(/^["']+|["']+$/g, ''))
      .filter(Boolean)
    return Array.from(new Set(tokens))
  }

containsAtSign(text: string): boolean {
    if (!text) return false
    return text.includes('@') || text.includes('＠')
  }

footprintMessageLikelyContainsAt(rawContent: unknown): boolean {
    if (rawContent === null || rawContent === undefined) return false
    const text = typeof rawContent === 'string' ? rawContent : String(rawContent || '')
    return this.containsAtSign(text)
  }

matchesMyFootprintIdentity(rawToken: string, identitySet: Set<string>): boolean {
    const token = String(rawToken || '').trim().replace(/^@+/, '')
    if (!token) return false

    const normalizedCandidates = new Set<string>()
    const addCandidate = (value: string) => {
      const normalized = String(value || '').trim().toLowerCase()
      if (!normalized) return
      normalizedCandidates.add(normalized)
    }

    addCandidate(token)
    addCandidate(token.replace(/@chatroom$/i, ''))
    addCandidate(token.replace(/@openim$/i, ''))

    for (const candidate of normalizedCandidates) {
      if (!candidate) continue
      for (const selfId of identitySet) {
        if (!selfId) continue
        if (candidate === selfId) return true
        if (candidate.startsWith(`${selfId}_`) || selfId.startsWith(`${candidate}_`)) return true
      }
    }
    return false
  }

buildMyFootprintIdentitySet(myWxid: string): Set<string> {
    const set = new Set<string>()
    const add = (value: string) => {
      const normalized = String(value || '').trim().toLowerCase()
      if (!normalized) return
      set.add(normalized)
    }

    const raw = String(myWxid || '').trim()
    add(raw)
    add(cleanAccountDirName(raw))
    for (const key of buildIdentityKeys(raw)) {
      add(key)
    }
    return set
  }

buildFootprintSourceCandidates(source: unknown): string[] {
    const sourceCandidates: string[] = []
    const seen = new Set<string>()
    const pushCandidate = (value: unknown) => {
      const normalized = cleanUtf16(String(value || '').trim())
      if (!normalized) return
      if (seen.has(normalized)) return
      seen.add(normalized)
      sourceCandidates.push(normalized)
    }

    const rawSource = typeof source === 'string'
      ? source
      : Buffer.isBuffer(source) || source instanceof Uint8Array
        ? Buffer.from(source).toString('utf-8')
        : typeof source === 'object' && source !== null && Array.isArray((source as { data?: unknown }).data)
          ? Buffer.from((source as { data: number[] }).data).toString('utf-8')
          : String(source || '')
    const normalizedSource = String(rawSource || '').trim()
    pushCandidate(normalizedSource)
    if (normalizedSource.includes('&')) {
      pushCandidate(decodeHtmlEntities(normalizedSource))
    }

    const sourceLooksEncoded = normalizedSource.length > 16
      && (looksLikeHex(normalizedSource) || looksLikeBase64(normalizedSource))
    if (sourceLooksEncoded) {
      const decodedFromText = decodeMaybeCompressed(normalizedSource, 'footprint_source')
      pushCandidate(decodedFromText)
      if (decodedFromText.includes('&')) {
        pushCandidate(decodeHtmlEntities(decodedFromText))
      }
    } else if (typeof source !== 'string') {
      const decodedFromBinary = decodeMaybeCompressed(source, 'footprint_source')
      pushCandidate(decodedFromBinary)
      if (decodedFromBinary.includes('&')) {
        pushCandidate(decodeHtmlEntities(decodedFromBinary))
      }
    }

    return sourceCandidates
  }

normalizeFootprintSourceForOutput(source: unknown): string {
    if (source === null || source === undefined) return ''
    if (typeof source === 'string') return source.trim()
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      return decodeBinaryContent(Buffer.from(source), '').trim()
    }
    if (typeof source === 'object' && source !== null && Array.isArray((source as { data?: unknown }).data)) {
      return decodeBinaryContent(Buffer.from((source as { data: number[] }).data), '').trim()
    }
    return String(source || '').trim()
  }

extractAtUserListTokensFromSource(source: unknown, prebuiltCandidates?: string[]): string[] {
    const tokens = new Set<string>()
    const sourceCandidates = Array.isArray(prebuiltCandidates) && prebuiltCandidates.length > 0
      ? prebuiltCandidates
      : this.buildFootprintSourceCandidates(source)
    const addTokens = (values: string[]) => {
      for (const value of values) {
        const normalized = String(value || '').trim()
        if (!normalized) continue
        tokens.add(normalized)
      }
    }

    const xmlPattern = /<atuserlist[^>]*>([\s\S]*?)<\/atuserlist>/gi
    const cdataPattern = /<!\[CDATA\[([\s\S]*?)\]\]>/i
    for (const candidateSource of sourceCandidates) {
      if (!candidateSource.toLowerCase().includes('atuserlist')) continue

      const trimmedCandidateSource = candidateSource.trim()
      const maybeJson = trimmedCandidateSource.startsWith('{')
        || trimmedCandidateSource.startsWith('[')
        || trimmedCandidateSource.includes('"atuserlist"')
      if (maybeJson) {
        try {
          const parsed = JSON.parse(candidateSource)
          const atUserList = parsed?.atuserlist
          if (Array.isArray(atUserList)) {
            const values = atUserList
              .map((item: unknown) => this.splitAtUserList(String(item || '')))
              .flat()
            addTokens(values)
          }
          if (typeof atUserList === 'string') {
            addTokens(this.splitAtUserList(atUserList))
          }
        } catch {
          // ignore JSON parse error and continue fallback parsing
        }
      }

      const jsonMatch = candidateSource.match(/"atuserlist"\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|[^,}\s]+)/i)
      if (jsonMatch) {
        const jsonCandidate = String(jsonMatch[1] || '').trim()
        if (jsonCandidate.startsWith('[')) {
          try {
            const arr = JSON.parse(jsonCandidate)
            if (Array.isArray(arr)) {
              const values = arr
                .map((item) => this.splitAtUserList(String(item || '')))
                .flat()
              addTokens(values)
            }
          } catch {
            // ignore array parse error
          }
        }
        const unquoted = jsonCandidate.replace(/^["']+|["']+$/g, '')
        addTokens(this.splitAtUserList(unquoted))
      }

      xmlPattern.lastIndex = 0
      let xmlMatch: RegExpExecArray | null
      while ((xmlMatch = xmlPattern.exec(candidateSource)) !== null) {
        let xmlValue = String(xmlMatch[1] || '')
        const cdataMatch = xmlValue.match(cdataPattern)
        if (cdataMatch?.[1]) {
          xmlValue = cdataMatch[1]
        }
        addTokens(this.splitAtUserList(xmlValue))
      }
    }

    return Array.from(tokens)
  }

sourceAtUserListContains(source: unknown, myWxid: string): boolean {
    const selfIdentitySet = this.buildMyFootprintIdentitySet(myWxid)
    return this.sourceAtUserListContainsWithIdentitySet(source, selfIdentitySet)
  }

sourceAtUserListContainsWithIdentitySet(source: unknown, selfIdentitySet: Set<string>): boolean {
    if (selfIdentitySet.size === 0) return false
    if (typeof source === 'string') {
      const raw = source.trim()
      if (!raw) return false
      const loweredRaw = raw.toLowerCase()
      if (loweredRaw.includes('atuserlist')) {
        for (const identity of selfIdentitySet) {
          if (identity && loweredRaw.includes(identity)) {
            return true
          }
        }
        const quickXmlMatch = raw.match(/<atuserlist[^>]*>([\s\S]*?)<\/atuserlist>/i)
        if (quickXmlMatch?.[1]) {
          const inner = quickXmlMatch[1]
          const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1] || inner
          const quickTokens = this.splitAtUserList(cdata)
          if (quickTokens.some((token) => this.matchesMyFootprintIdentity(token, selfIdentitySet))) {
            return true
          }
        }
      } else if (raw.length <= 16 || (!looksLikeHex(raw) && !looksLikeBase64(raw))) {
        return false
      }
    }
    const sourceCandidates = this.buildFootprintSourceCandidates(source)
    for (const candidate of sourceCandidates) {
      const normalized = String(candidate || '').toLowerCase()
      if (!normalized || !normalized.includes('atuserlist')) continue
      for (const identity of selfIdentitySet) {
        if (identity && normalized.includes(identity)) {
          return true
        }
      }
    }
    const tokens = this.extractAtUserListTokensFromSource(source, sourceCandidates)
    if (tokens.length === 0) return false
    return tokens.some((token) => this.matchesMyFootprintIdentity(token, selfIdentitySet))
  }

async resolveMyFootprintGroupSessionIds(
    groupSessionIds: string[],
    beginTimestamp = 0,
    endTimestamp = 0
  ): Promise<string[]> {
    const normalized = Array.from(new Set(
      (groupSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value.endsWith('@chatroom'))
    ))
    const begin = normalizeTimestampSeconds(beginTimestamp)
    const end = normalizeTimestampSeconds(endTimestamp)
    void begin
    void end

    const merged: string[] = []
    const seen = new Set<string>()
    const sessionLastTsMap = new Map<string, number>()
    const hasSessionRank = new Set<string>()
    const shouldKeepByLastTs = (sessionId: string, preferKeepUnknown: boolean): boolean => {
      const normalizedSessionId = String(sessionId || '').trim()
      if (!normalizedSessionId) return false
      const lastTs = normalizeTimestampSeconds(sessionLastTsMap.get(normalizedSessionId) || 0)
      const known = hasSessionRank.has(normalizedSessionId)
      if (!known) return preferKeepUnknown || begin <= 0
      if (begin > 0 && lastTs > 0 && lastTs < begin) return false
      return true
    }
    const push = (value: string) => {
      const normalizedValue = String(value || '').trim()
      if (!normalizedValue || !normalizedValue.endsWith('@chatroom')) return
      if (seen.has(normalizedValue)) return
      seen.add(normalizedValue)
      merged.push(normalizedValue)
    }

    try {
      const sessionsResult = await this.host.getSessions()
      if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
        const rankedGroups = sessionsResult.sessions
          .map((session) => {
            const sessionId = String(session?.username || '').trim()
            const lastTs = normalizeTimestampSeconds(
              Number(session?.lastTimestamp || session?.sortTimestamp || 0)
            )
            if (sessionId.endsWith('@chatroom')) {
              hasSessionRank.add(sessionId)
              sessionLastTsMap.set(sessionId, lastTs)
            }
            return { sessionId, lastTs }
          })
          .filter((item) => item.sessionId.endsWith('@chatroom'))
          .filter((item) => shouldKeepByLastTs(item.sessionId, false))
          .sort((a, b) => {
            if (a.lastTs !== b.lastTs) return b.lastTs - a.lastTs
            return a.sessionId.localeCompare(b.sessionId)
          })
        for (const item of rankedGroups) {
          push(item.sessionId)
        }
      }
    } catch {
      // ignore session-based scope resolution failure
    }

    try {
      const contactGroups = await this.listMyFootprintGroupSessionIdsFromContact()
      for (const sessionId of contactGroups) {
        if (!shouldKeepByLastTs(sessionId, false)) continue
        push(sessionId)
      }
    } catch {
      // ignore contact-based scope resolution failure
    }

    for (const sessionId of normalized) {
      if (!shouldKeepByLastTs(sessionId, true)) continue
      push(sessionId)
    }

    return merged.length > 0 ? merged : normalized
  }

async listMyFootprintGroupSessionIdsFromContact(): Promise<string[]> {
    try {
      const result = await wcdbService.execQuery(
        'contact',
        null,
        "SELECT username FROM contact WHERE username IS NOT NULL AND username != '' AND username LIKE '%@chatroom'"
      )
      if (!result.success || !Array.isArray(result.rows)) {
        return []
      }

      return Array.from(new Set(
        (result.rows as Array<Record<string, any>>)
          .map((row) => String(getRowField(row, ['username', 'user_name', 'userName']) || '').trim())
          .filter((value) => value.endsWith('@chatroom'))
      ))
    } catch {
      return []
    }
  }

async filterMyFootprintPrivateSessions(privateSessionIds: string[]): Promise<string[]> {
    const normalized = Array.from(new Set(
      (privateSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.endsWith('@chatroom'))
    ))
    if (normalized.length === 0) return normalized

    try {
      const officialSessionIds = await this.getMyFootprintOfficialSessionIdSet(normalized)
      if (officialSessionIds.size === 0) return normalized
      return normalized.filter((sessionId) => !officialSessionIds.has(sessionId))
    } catch {
      return normalized
    }
  }

async getMyFootprintOfficialSessionIdSet(privateSessionIds: string[]): Promise<Set<string>> {
    const officialSessionIds = new Set<string>()
    const normalized = Array.from(new Set(
      (privateSessionIds || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.endsWith('@chatroom'))
    ))
    if (normalized.length === 0) return officialSessionIds

    for (const sessionId of normalized) {
      if (sessionId.startsWith('gh_')) {
        officialSessionIds.add(sessionId)
      }
    }

    const chunkSize = 320
    const buildInListSql = (values: string[]) => values
      .map((value) => `'${this.host.escapeSqlString(value)}'`)
      .join(',')

    try {
      const bizInfoTableResult = await wcdbService.execQuery(
        'contact',
        null,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name)='biz_info' LIMIT 1"
      )
      const bizInfoTableName = bizInfoTableResult.success && Array.isArray(bizInfoTableResult.rows)
        ? String((bizInfoTableResult.rows[0] as Record<string, any> | undefined)?.name || '').trim()
        : ''
      if (bizInfoTableName) {
        const tableSqlName = this.host.quoteSqlIdentifier(bizInfoTableName)
        for (let index = 0; index < normalized.length; index += chunkSize) {
          const batch = normalized.slice(index, index + chunkSize)
          if (batch.length === 0) continue
          const inListSql = buildInListSql(batch)
          const sql = `SELECT username FROM ${tableSqlName} WHERE username IN (${inListSql})`
          const result = await wcdbService.execQuery('contact', null, sql)
          if (!result.success || !Array.isArray(result.rows)) continue
          for (const row of result.rows as Array<Record<string, any>>) {
            const username = String(getRowField(row, ['username', 'user_name', 'userName']) || '').trim()
            if (username) officialSessionIds.add(username)
          }
        }
      }
    } catch {
      // ignore biz_info lookup failure
    }

    try {
      const tableInfo = await wcdbService.execQuery('contact', null, 'PRAGMA table_info(contact)')
      if (tableInfo.success && Array.isArray(tableInfo.rows)) {
        const availableColumns = new Map<string, string>()
        for (const row of tableInfo.rows as Array<Record<string, any>>) {
          const rawName = row.name ?? row.column_name ?? row.columnName
          const name = String(rawName || '').trim()
          if (!name) continue
          availableColumns.set(name.toLowerCase(), name)
        }

        const pickColumn = (candidates: string[]): string | null => {
          for (const candidate of candidates) {
            const actual = availableColumns.get(candidate.toLowerCase())
            if (actual) return actual
          }
          return null
        }

        const usernameColumn = pickColumn(['username', 'user_name', 'userName'])
        const officialFlagColumns = [
          pickColumn(['verify_flag', 'verifyFlag', 'verifyflag']),
          pickColumn(['verify_status', 'verifyStatus']),
          pickColumn(['verify_type', 'verifyType']),
          pickColumn(['biz_type', 'bizType']),
          pickColumn(['brand_flag', 'brandFlag']),
          pickColumn(['service_type', 'serviceType'])
        ].filter((column): column is string => Boolean(column))

        if (usernameColumn && officialFlagColumns.length > 0) {
          const selectColumns = Array.from(new Set([usernameColumn, ...officialFlagColumns]))
          const selectSql = selectColumns.map((column) => this.host.quoteSqlIdentifier(column)).join(', ')
          for (let index = 0; index < normalized.length; index += chunkSize) {
            const batch = normalized.slice(index, index + chunkSize)
            if (batch.length === 0) continue
            const inListSql = buildInListSql(batch)
            const sql = `SELECT ${selectSql} FROM contact WHERE ${this.host.quoteSqlIdentifier(usernameColumn)} IN (${inListSql})`
            const result = await wcdbService.execQuery('contact', null, sql)
            if (!result.success || !Array.isArray(result.rows)) continue
            for (const row of result.rows as Array<Record<string, any>>) {
              const username = String(getRowField(row, [usernameColumn, 'username', 'user_name', 'userName']) || '').trim()
              if (!username) continue
              const hasOfficialFlag = officialFlagColumns.some((column) => (
                this.isTruthyMyFootprintOfficialFlag(getRowField(row, [column]))
              ))
              if (hasOfficialFlag) {
                officialSessionIds.add(username)
              }
            }
          }
        }
      }
    } catch {
      // ignore contact-flag lookup failure
    }

    return officialSessionIds
  }

isTruthyMyFootprintOfficialFlag(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) && value > 0

    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized) return false
    if (normalized === '0' || normalized === 'false' || normalized === 'null' || normalized === 'undefined') {
      return false
    }

    const numeric = Number(normalized)
    if (Number.isFinite(numeric)) {
      return numeric > 0
    }
    return true
  }

normalizeMyFootprintData(raw: any): MyFootprintData {
    const summaryRaw = raw?.summary || {}
    const privateSessionsRaw = Array.isArray(raw?.private_sessions) ? raw.private_sessions : []
    const privateSegmentsRaw = Array.isArray(raw?.private_segments) ? raw.private_segments : []
    const mentionsRaw = Array.isArray(raw?.mentions) ? raw.mentions : []
    const mentionGroupsRaw = Array.isArray(raw?.mention_groups) ? raw.mention_groups : []
    const diagnosticsRaw = raw?.diagnostics || {}

    const summary: MyFootprintSummary = {
      private_inbound_people: toSafeInt(summaryRaw.private_inbound_people, 0),
      private_replied_people: toSafeInt(summaryRaw.private_replied_people, 0),
      private_outbound_people: toSafeInt(summaryRaw.private_outbound_people, 0),
      private_reply_rate: toSafeNumber(summaryRaw.private_reply_rate, 0),
      mention_count: toSafeInt(summaryRaw.mention_count, 0),
      mention_group_count: toSafeInt(summaryRaw.mention_group_count, 0)
    }

    const private_sessions: MyFootprintPrivateSession[] = privateSessionsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      incoming_count: toSafeInt(item?.incoming_count, 0),
      outgoing_count: toSafeInt(item?.outgoing_count, 0),
      replied: Boolean(item?.replied),
      first_incoming_ts: toSafeInt(item?.first_incoming_ts, 0),
      first_reply_ts: toSafeInt(item?.first_reply_ts, 0),
      latest_ts: toSafeInt(item?.latest_ts, 0),
      anchor_local_id: toSafeInt(item?.anchor_local_id, 0),
      anchor_create_time: toSafeInt(item?.anchor_create_time, 0)
    })).filter((item: MyFootprintPrivateSession) => item.session_id)

    const private_segments: MyFootprintPrivateSegment[] = privateSegmentsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      segment_index: toSafeInt(item?.segment_index, 0),
      start_ts: toSafeInt(item?.start_ts, 0),
      end_ts: toSafeInt(item?.end_ts, 0),
      duration_sec: toSafeInt(item?.duration_sec, 0),
      incoming_count: toSafeInt(item?.incoming_count, 0),
      outgoing_count: toSafeInt(item?.outgoing_count, 0),
      message_count: toSafeInt(item?.message_count, 0),
      replied: Boolean(item?.replied),
      first_incoming_ts: toSafeInt(item?.first_incoming_ts, 0),
      first_reply_ts: toSafeInt(item?.first_reply_ts, 0),
      latest_ts: toSafeInt(item?.latest_ts, 0),
      anchor_local_id: toSafeInt(item?.anchor_local_id, 0),
      anchor_create_time: toSafeInt(item?.anchor_create_time, 0),
      displayName: String(item?.displayName || '').trim() || undefined,
      avatarUrl: String(item?.avatarUrl || '').trim() || undefined
    })).filter((item: MyFootprintPrivateSegment) => item.session_id && item.start_ts > 0)

    const mentions: MyFootprintMentionItem[] = mentionsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      local_id: toSafeInt(item?.local_id, 0),
      create_time: toSafeInt(item?.create_time, 0),
      sender_username: String(item?.sender_username || '').trim(),
      message_content: String(item?.message_content || ''),
      source: String(item?.source || '')
    })).filter((item: MyFootprintMentionItem) => item.session_id)

    const mention_groups: MyFootprintMentionGroup[] = mentionGroupsRaw.map((item: any) => ({
      session_id: String(item?.session_id || '').trim(),
      count: toSafeInt(item?.count, 0),
      latest_ts: toSafeInt(item?.latest_ts, 0)
    })).filter((item: MyFootprintMentionGroup) => item.session_id)

    const diagnostics: MyFootprintDiagnostics = {
      truncated: Boolean(diagnosticsRaw.truncated),
      scanned_dbs: toSafeInt(diagnosticsRaw.scanned_dbs, 0),
      elapsed_ms: toSafeInt(diagnosticsRaw.elapsed_ms, 0),
      mention_truncated: Boolean(diagnosticsRaw.mention_truncated),
      private_truncated: Boolean(diagnosticsRaw.private_truncated)
    }

    return {
      summary,
      private_sessions,
      private_segments,
      mentions,
      mention_groups,
      diagnostics
    }
  }

filterMyFootprintMentionsBySource(data: MyFootprintData, myWxid: string, mentionLimit: number): MyFootprintData {
    const identitySet = this.buildMyFootprintIdentitySet(myWxid)
    if (identitySet.size === 0) {
      return {
        ...data,
        summary: {
          ...data.summary,
          mention_count: 0,
          mention_group_count: 0
        },
        mentions: [],
        mention_groups: []
      }
    }

    const sourceMatchCache = new Map<string, boolean>()
    const filteredMentions = data.mentions.filter((item) => {
      const sourceKey = String(item.source || '')
      const cachedMatched = sourceMatchCache.get(sourceKey)
      if (cachedMatched !== undefined) return cachedMatched
      const matched = this.sourceAtUserListContainsWithIdentitySet(item.source, identitySet)
      if (sourceMatchCache.size < 4096) {
        sourceMatchCache.set(sourceKey, matched)
      }
      return matched
    })
      .sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })

    let truncatedByFrontendLimit = false
    if (mentionLimit > 0 && filteredMentions.length > mentionLimit) {
      filteredMentions.length = mentionLimit
      truncatedByFrontendLimit = true
    }

    const mentionGroupMap = new Map<string, MyFootprintMentionGroup>()
    for (const mention of filteredMentions) {
      const group = mentionGroupMap.get(mention.session_id) || {
        session_id: mention.session_id,
        count: 0,
        latest_ts: 0
      }
      group.count += 1
      if (mention.create_time > group.latest_ts) group.latest_ts = mention.create_time
      mentionGroupMap.set(mention.session_id, group)
    }

    const filteredMentionGroups = Array.from(mentionGroupMap.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
        return a.session_id.localeCompare(b.session_id)
      })

    const nextSummary: MyFootprintSummary = {
      ...data.summary,
      mention_count: filteredMentions.length,
      mention_group_count: filteredMentionGroups.length
    }

    return {
      ...data,
      summary: nextSummary,
      mentions: filteredMentions,
      mention_groups: filteredMentionGroups,
      diagnostics: {
        ...data.diagnostics,
        truncated: Boolean(data.diagnostics.truncated || truncatedByFrontendLimit)
      }
    }
  }

mergeMyFootprintMentionResult(base: MyFootprintData, mentionResult: MyFootprintData): MyFootprintData {
    const mentionMap = new Map<string, MyFootprintMentionItem>()
    const pushMention = (item: MyFootprintMentionItem) => {
      const key = `${item.session_id}#${item.local_id}#${item.create_time}`
      mentionMap.set(key, item)
    }
    for (const item of base.mentions) pushMention(item)
    for (const item of mentionResult.mentions) pushMention(item)

    const mergedMentions = Array.from(mentionMap.values())
      .sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })

    const mentionGroupMetaMap = new Map<string, Pick<MyFootprintMentionGroup, 'displayName' | 'avatarUrl'>>()
    const pushGroupMeta = (group: MyFootprintMentionGroup) => {
      const prev = mentionGroupMetaMap.get(group.session_id) || {}
      mentionGroupMetaMap.set(group.session_id, {
        displayName: group.displayName || prev.displayName,
        avatarUrl: group.avatarUrl || prev.avatarUrl
      })
    }
    for (const group of base.mention_groups) pushGroupMeta(group)
    for (const group of mentionResult.mention_groups) pushGroupMeta(group)

    const mentionGroupMap = new Map<string, MyFootprintMentionGroup>()
    for (const mention of mergedMentions) {
      const current = mentionGroupMap.get(mention.session_id) || {
        session_id: mention.session_id,
        count: 0,
        latest_ts: 0
      }
      current.count += 1
      if (mention.create_time > current.latest_ts) {
        current.latest_ts = mention.create_time
      }
      mentionGroupMap.set(mention.session_id, current)
    }

    const mergedMentionGroups = Array.from(mentionGroupMap.values())
      .map((group) => {
        const meta = mentionGroupMetaMap.get(group.session_id)
        return {
          ...group,
          displayName: meta?.displayName,
          avatarUrl: meta?.avatarUrl
        }
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
        return a.session_id.localeCompare(b.session_id)
      })

    return {
      ...base,
      summary: {
        ...base.summary,
        mention_count: mergedMentions.length,
        mention_group_count: mergedMentionGroups.length
      },
      private_segments: mentionResult.private_segments.length > 0
        ? mentionResult.private_segments
        : base.private_segments,
      mentions: mergedMentions,
      mention_groups: mergedMentionGroups,
      diagnostics: {
        ...base.diagnostics,
        truncated: Boolean(base.diagnostics.truncated || mentionResult.diagnostics.truncated),
        scanned_dbs: Math.max(base.diagnostics.scanned_dbs || 0, mentionResult.diagnostics.scanned_dbs || 0),
        elapsed_ms: Math.max(base.diagnostics.elapsed_ms || 0, mentionResult.diagnostics.elapsed_ms || 0)
      }
    }
  }

shouldRunMyFootprintHeavyDebug(): boolean {
    const flag = String(process.env.WEFLOW_MY_FOOTPRINT_DEBUG || '').trim().toLowerCase()
    return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
  }

async logMyFootprintZeroMentionDebug(params: {
    begin: number
    end: number
    myWxid: string
    groupSessionIds: string[]
    nativeData: MyFootprintData
  }): Promise<void> {
    try {
      const identityKeySet = this.buildMyFootprintIdentitySet(params.myWxid)
      const identitySet = Array.from(identityKeySet)
      console.warn(
        `[MyFootprint][debug] zero mentions: myWxid=${params.myWxid} identityKeys=${identitySet.join('|')} groups=${params.groupSessionIds.length} nativeMentions=${params.nativeData.mentions.length} nativeMentionGroups=${params.nativeData.mention_groups.length} scannedDbs=${params.nativeData.diagnostics.scanned_dbs}`
      )

      if (params.nativeData.mentions.length > 0) {
        const samples = params.nativeData.mentions.slice(0, 5).map((item) => {
          const tokens = this.extractAtUserListTokensFromSource(item.source)
          const matched = tokens.some((token) => this.matchesMyFootprintIdentity(token, identityKeySet))
          return {
            sessionId: item.session_id,
            localId: item.local_id,
            createTime: item.create_time,
            tokens,
            matched
          }
        })
        console.warn(`[MyFootprint][debug] native mention samples=${JSON.stringify(samples)}`)
      }

      const allGroups = params.groupSessionIds
      console.warn(`[MyFootprint][debug] start group scan: totalGroups=${allGroups.length}`)
      let skippedNoTableGroups = 0
      let sqlProbeCount = 0
      let nativeSingleProbeCount = 0
      for (let index = 0; index < allGroups.length; index += 1) {
        const sessionId = allGroups[index]
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          120,
          false,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) {
          const openCursorError = String(cursorResult.error || 'unknown')
          if (openCursorError.includes('-3')) {
            skippedNoTableGroups += 1
            console.warn(`[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] skipped(no message table): ${openCursorError}`)
          } else {
            console.warn(`[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] open cursor failed: ${openCursorError}`)
          }
          continue
        }

        let rows = 0
        let atContentRows = 0
        let sourcePresentRows = 0
        let atUserListRows = 0
        let matchedRows = 0
        const unmatchedSamples: Array<{
          localId: number
          createTime: number
          tokens: string[]
          sourcePreview: string
        }> = []

        let hasMore = true
        try {
          while (hasMore && rows < 200) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              rows += 1
              if (rows > 200) break

              const messageContentRaw = row.message_content ?? row.messageContent ?? row.content
              const hasAtInContent = this.footprintMessageLikelyContainsAt(messageContentRaw)
              if (hasAtInContent) atContentRows += 1

              const sourceRaw = row.source ?? row.msg_source ?? row.message_source
              if (sourceRaw !== null && sourceRaw !== undefined && String(sourceRaw).trim().length > 0) {
                sourcePresentRows += 1
              }
              if (!hasAtInContent) continue

              const tokens = this.extractAtUserListTokensFromSource(sourceRaw)
              if (tokens.length > 0) atUserListRows += 1
              const matched = tokens.some((token) => this.matchesMyFootprintIdentity(token, identityKeySet))
              if (matched) {
                matchedRows += 1
              } else if (tokens.length > 0 && unmatchedSamples.length < 3) {
                const sourceDecoded = decodeMaybeCompressed(sourceRaw, 'footprint_source') || String(sourceRaw || '')
                unmatchedSamples.push({
                  localId: toSafeInt(row.local_id, 0),
                  createTime: toSafeInt(row.create_time, 0),
                  tokens,
                  sourcePreview: sourceDecoded.replace(/\s+/g, ' ').slice(0, 260)
                })
              }
            }
          }
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }

        console.warn(
          `[MyFootprint][debug][${index + 1}/${allGroups.length}][${sessionId}] rows=${rows} atContentRows=${atContentRows} sourcePresentRows=${sourcePresentRows} atUserListRows=${atUserListRows} matchedRows=${matchedRows}`
        )
        if (unmatchedSamples.length > 0) {
          console.warn(`[MyFootprint][debug][${sessionId}] unmatchedSamples=${JSON.stringify(unmatchedSamples)}`)
        }

        if ((matchedRows > 0 || atContentRows > 0 || atUserListRows > 0) && sqlProbeCount < 6) {
          sqlProbeCount += 1
          await this.logMyFootprintNativeSqlProbe(sessionId, params.begin, params.end)
        }
        if (matchedRows > 0 && nativeSingleProbeCount < 4) {
          nativeSingleProbeCount += 1
          await this.logMyFootprintNativeSingleGroupProbe(sessionId, params.begin, params.end, params.myWxid)
        }
      }
      if (skippedNoTableGroups > 0) {
        console.warn(`[MyFootprint][debug] skippedNoTableGroups=${skippedNoTableGroups}/${allGroups.length}`)
      }
    } catch (error) {
      console.warn('[MyFootprint][debug] zero mention diagnostics failed:', error)
    }
  }

async printMyFootprintNativeLogs(tag: string): Promise<void> {
    try {
      const logsResult = await wcdbService.getLogs()
      if (!logsResult.success || !Array.isArray(logsResult.logs)) {
        console.warn(`[MyFootprint][native-log][${tag}] getLogs failed: ${logsResult.error || 'unknown'}`)
        return
      }

      const logs = logsResult.logs
        .map((line) => String(line || '').trim())
        .filter(Boolean)
      const keywords = [
        'wcdb_get_my_footprint_stats',
        'message_db_cache_refresh',
        'open_message_cursor',
        'open_message_cursor_lite',
        'cursor_init',
        'schema mismatch',
        'no message db',
        'get_sessions'
      ]
      const related = logs.filter((line) => {
        const lowered = line.toLowerCase()
        return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))
      })

      console.warn(
        `[MyFootprint][native-log][${tag}] total=${logs.length} related=${related.length}`
      )
      const tail = related.slice(-240)
      for (const line of tail) {
        console.warn(`[MyFootprint][native-log] ${line}`)
      }
    } catch (error) {
      console.warn(`[MyFootprint][native-log][${tag}] exception:`, error)
    }
  }

async logMyFootprintNativeSqlProbe(sessionId: string, begin: number, end: number): Promise<void> {
    try {
      const tables = await this.host.getSessionMessageTables(sessionId)
      if (!Array.isArray(tables) || tables.length === 0) {
        console.warn(`[MyFootprint][sql-probe][${sessionId}] no tables`)
        return
      }

      const beginTs = normalizeTimestampSeconds(begin)
      const endTs = normalizeTimestampSeconds(end)
      const clauseTime = [
        beginTs > 0 ? `"create_time" >= ${beginTs}` : '',
        endTs > 0 ? `"create_time" <= ${endTs}` : ''
      ].filter(Boolean).join(' AND ')
      const whereParts: string[] = []
      if (clauseTime) whereParts.push(clauseTime)
      whereParts.push(`"source" IS NOT NULL`)
      whereParts.push(`"source" != ''`)
      whereParts.push(`(("message_content" IS NOT NULL AND "message_content" != '' AND (instr("message_content", '@') > 0 OR instr("message_content", '＠') > 0)) OR instr(lower("source"), 'atuserlist') > 0)`)
      const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : ''

      let total = 0
      for (const table of tables) {
        const tableName = String(table.tableName || '').trim()
        const dbPath = String(table.dbPath || '').trim()
        if (!tableName || !dbPath) continue
        const sql = `SELECT COUNT(1) AS cnt FROM ${this.host.quoteSqlIdentifier(tableName)}${whereSql}`
        const result = await wcdbService.execQuery('message', dbPath, sql)
        if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) {
          console.warn(`[MyFootprint][sql-probe][${sessionId}] query failed db=${dbPath} table=${tableName} err=${result.error || 'unknown'}`)
          continue
        }
        const cnt = toSafeInt((result.rows[0] as Record<string, any>).cnt, 0)
        total += cnt
        if (cnt > 0) {
          console.warn(`[MyFootprint][sql-probe][${sessionId}] db=${dbPath} table=${tableName} cnt=${cnt}`)
        }
      }
      console.warn(`[MyFootprint][sql-probe][${sessionId}] total=${total}`)
    } catch (error) {
      console.warn(`[MyFootprint][sql-probe][${sessionId}] exception:`, error)
    }
  }

async logMyFootprintNativeSingleGroupProbe(sessionId: string, begin: number, end: number, myWxid: string): Promise<void> {
    try {
      const probeResult = await wcdbService.getMyFootprintStats({
        beginTimestamp: begin,
        endTimestamp: end,
        myWxid,
        privateSessionIds: [],
        groupSessionIds: [sessionId],
        mentionLimit: 0,
        privateLimit: 0,
        mentionMode: 'text_at_me'
      })
      if (!probeResult.success || !probeResult.data) {
        console.warn(`[MyFootprint][single-native][${sessionId}] failed err=${probeResult.error || 'unknown'}`)
        return
      }

      const raw = this.normalizeMyFootprintData(probeResult.data)
      const first = raw.mentions[0]
      console.warn(
        `[MyFootprint][single-native][${sessionId}] mentions=${raw.mentions.length} groups=${raw.mention_groups.length} truncated=${raw.diagnostics.truncated} firstLocalId=${first?.local_id || 0} firstTs=${first?.create_time || 0}`
      )
    } catch (error) {
      console.warn(`[MyFootprint][single-native][${sessionId}] exception:`, error)
    }
  }

async getMyFootprintStatsByCursorFallback(params: {
    begin: number
    end: number
    myWxid: string
    privateSessionIds: string[]
    groupSessionIds: string[]
    mentionLimit: number
    privateLimit: number
    skipPrivateScan?: boolean
    mentionScanLimitPerGroup?: number
  }): Promise<{ success: boolean; data?: MyFootprintData; error?: string }> {
    const startedAt = Date.now()
    let truncated = false

    try {
      const privateSessionMap = new Map<string, MyFootprintPrivateSession>()
      type PrivateSegmentWorking = {
        segment_index: number
        start_ts: number
        end_ts: number
        incoming_count: number
        outgoing_count: number
        first_incoming_ts: number
        first_reply_ts: number
        anchor_local_id: number
        anchor_create_time: number
        latest_local_id: number
        latest_create_time: number
      }
      const privateSegments: MyFootprintPrivateSegment[] = []
      const mentionGroupsMap = new Map<string, MyFootprintMentionGroup>()
      const mentions: MyFootprintMentionItem[] = []
      const mentionIdentitySet = this.buildMyFootprintIdentitySet(params.myWxid)
      const mentionSourceMatchCache = new Map<string, boolean>()
      const mentionScanLimit = Number.isFinite(params.mentionScanLimitPerGroup as number)
        ? Math.max(60, Math.floor(Number(params.mentionScanLimitPerGroup)))
        : Math.max(params.mentionLimit * 12, 4000)
      const privateScanLimitPerSession = Math.max(
        120,
        Math.min(
          600,
          Math.floor((params.privateLimit * 2) / Math.max(params.privateSessionIds.length || 1, 1))
        )
      )
      const privateBatchSize = Math.min(200, privateScanLimitPerSession)
      const privateSessionGapSeconds = 10 * 60
      const mentionBatchSize = 360
      const skipPrivateScan = params.skipPrivateScan === true

      if (!skipPrivateScan) for (const sessionId of params.privateSessionIds) {
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          privateBatchSize,
          true,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) continue

        const stat: MyFootprintPrivateSession = {
          session_id: sessionId,
          incoming_count: 0,
          outgoing_count: 0,
          replied: false,
          first_incoming_ts: 0,
          first_reply_ts: 0,
          latest_ts: 0,
          anchor_local_id: 0,
          anchor_create_time: 0
        }
        let segmentCursor = 0
        let activeSegment: PrivateSegmentWorking | null = null
        let lastSegmentMessageTs = 0
        const commitActiveSegment = () => {
          if (!activeSegment) return

          const normalizedStart = activeSegment.start_ts > 0 ? activeSegment.start_ts : activeSegment.anchor_create_time
          const normalizedEnd = activeSegment.end_ts > 0 ? activeSegment.end_ts : normalizedStart
          const incomingCount = Math.max(0, activeSegment.incoming_count)
          const outgoingCount = Math.max(0, activeSegment.outgoing_count)
          const messageCount = incomingCount + outgoingCount
          if (normalizedStart > 0 && messageCount > 0) {
            privateSegments.push({
              session_id: sessionId,
              segment_index: activeSegment.segment_index,
              start_ts: normalizedStart,
              end_ts: normalizedEnd,
              duration_sec: Math.max(0, normalizedEnd - normalizedStart),
              incoming_count: incomingCount,
              outgoing_count: outgoingCount,
              message_count: messageCount,
              replied: incomingCount > 0 && outgoingCount > 0,
              first_incoming_ts: activeSegment.first_incoming_ts,
              first_reply_ts: activeSegment.first_reply_ts,
              latest_ts: normalizedEnd,
              anchor_local_id: activeSegment.anchor_local_id,
              anchor_create_time: normalizedStart
            })
          }
          activeSegment = null
        }

        let processed = 0
        let hasMore = true
        try {
          while (hasMore) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              if (processed >= privateScanLimitPerSession) {
                if (hasMore || batchResult.rows.length > 0) truncated = true
                hasMore = false
                break
              }
              processed += 1

              const createTime = toSafeInt(row.create_time, 0)
              const localId = toSafeInt(row.local_id, 0)
              const isSend = this.resolveFootprintRowIsSend(row, params.myWxid)

              if (createTime > 0) {
                const startNewSegment = !activeSegment
                  || (lastSegmentMessageTs > 0 && createTime - lastSegmentMessageTs > privateSessionGapSeconds)
                if (startNewSegment) {
                  commitActiveSegment()
                  segmentCursor += 1
                  activeSegment = {
                    segment_index: segmentCursor,
                    start_ts: createTime,
                    end_ts: createTime,
                    incoming_count: 0,
                    outgoing_count: 0,
                    first_incoming_ts: 0,
                    first_reply_ts: 0,
                    anchor_local_id: localId,
                    anchor_create_time: createTime,
                    latest_local_id: localId,
                    latest_create_time: createTime
                  }
                }
              } else if (!activeSegment) {
                segmentCursor += 1
                activeSegment = {
                  segment_index: segmentCursor,
                  start_ts: 0,
                  end_ts: 0,
                  incoming_count: 0,
                  outgoing_count: 0,
                  first_incoming_ts: 0,
                  first_reply_ts: 0,
                  anchor_local_id: localId,
                  anchor_create_time: 0,
                  latest_local_id: localId,
                  latest_create_time: 0
                }
              }

              if (isSend) {
                stat.outgoing_count += 1
                if (
                  createTime > 0
                  && stat.first_incoming_ts > 0
                  && createTime >= stat.first_incoming_ts
                  && stat.first_reply_ts <= 0
                ) {
                  stat.first_reply_ts = createTime
                }
                if (activeSegment) {
                  activeSegment.outgoing_count += 1
                  if (
                    createTime > 0
                    && activeSegment.first_incoming_ts > 0
                    && createTime >= activeSegment.first_incoming_ts
                    && activeSegment.first_reply_ts <= 0
                  ) {
                    activeSegment.first_reply_ts = createTime
                  }
                }
              } else {
                stat.incoming_count += 1
                if (stat.first_incoming_ts <= 0 || (createTime > 0 && createTime < stat.first_incoming_ts)) {
                  stat.first_incoming_ts = createTime
                }
                if (activeSegment) {
                  activeSegment.incoming_count += 1
                  if (activeSegment.first_incoming_ts <= 0 || (createTime > 0 && createTime < activeSegment.first_incoming_ts)) {
                    activeSegment.first_incoming_ts = createTime
                  }
                }
              }

              if (stat.latest_ts <= 0 || createTime > stat.latest_ts || (createTime === stat.latest_ts && localId > stat.anchor_local_id)) {
                stat.latest_ts = createTime
                stat.anchor_local_id = localId
                stat.anchor_create_time = createTime
              }

              if (activeSegment && createTime > 0) {
                activeSegment.end_ts = createTime
                activeSegment.latest_create_time = createTime
                activeSegment.latest_local_id = localId
                lastSegmentMessageTs = createTime
              }
            }
          }
          if (hasMore) truncated = true
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }
        commitActiveSegment()
        stat.replied = stat.incoming_count > 0 && stat.outgoing_count > 0

        if (stat.incoming_count > 0 || stat.outgoing_count > 0 || stat.latest_ts > 0) {
          privateSessionMap.set(sessionId, stat)
        }
      }

      for (const sessionId of params.groupSessionIds) {
        if (mentions.length >= params.mentionLimit) {
          truncated = true
          break
        }
        const cursorResult = await wcdbService.openMessageCursorLite(
          sessionId,
          mentionBatchSize,
          false,
          params.begin,
          params.end
        )
        if (!cursorResult.success || !cursorResult.cursor) continue

        let scanned = 0
        let hasMore = true
        try {
          while (hasMore && scanned < mentionScanLimit) {
            const batchResult = await wcdbService.fetchMessageBatch(cursorResult.cursor)
            if (!batchResult.success || !Array.isArray(batchResult.rows)) {
              break
            }
            hasMore = Boolean(batchResult.hasMore)
            for (const row of batchResult.rows as Array<Record<string, any>>) {
              if (mentions.length >= params.mentionLimit) {
                truncated = true
                hasMore = false
                break
              }
              scanned += 1
              const messageContentRaw = row.message_content ?? row.messageContent ?? row.content
              if (!this.footprintMessageLikelyContainsAt(messageContentRaw)) continue
              const sourceRaw = row.source ?? row.msg_source ?? row.message_source
              let sourceMatched = false
              if (typeof sourceRaw === 'string') {
                const sourceKey = sourceRaw
                const cachedMatched = mentionSourceMatchCache.get(sourceKey)
                if (cachedMatched !== undefined) {
                  sourceMatched = cachedMatched
                } else {
                  sourceMatched = this.sourceAtUserListContainsWithIdentitySet(sourceRaw, mentionIdentitySet)
                  if (mentionSourceMatchCache.size < 8192) {
                    mentionSourceMatchCache.set(sourceKey, sourceMatched)
                  }
                }
              } else {
                sourceMatched = this.sourceAtUserListContainsWithIdentitySet(sourceRaw, mentionIdentitySet)
              }
              if (!sourceMatched) continue
              const normalizedSource = this.normalizeFootprintSourceForOutput(sourceRaw)

              let senderUsername = String(row.sender_username || row.senderUsername || '').trim()
              if (!senderUsername && row._db_path && row.real_sender_id) {
                senderUsername = await this.host.resolveMessageSenderUsernameById(
                  String(row._db_path),
                  row.real_sender_id
                ) || ''
              }

              const mention: MyFootprintMentionItem = {
                session_id: sessionId,
                local_id: toSafeInt(row.local_id, 0),
                create_time: toSafeInt(row.create_time, 0),
                sender_username: senderUsername,
                message_content: String(row.message_content || row.messageContent || ''),
                source: normalizedSource
              }
              mentions.push(mention)

              const group = mentionGroupsMap.get(sessionId) || {
                session_id: sessionId,
                count: 0,
                latest_ts: 0
              }
              group.count += 1
              if (mention.create_time > group.latest_ts) group.latest_ts = mention.create_time
              mentionGroupsMap.set(sessionId, group)
            }
          }
          if (hasMore || scanned >= mentionScanLimit) {
            truncated = true
          }
        } finally {
          await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => {})
        }
      }

      mentions.sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time - a.create_time
        return b.local_id - a.local_id
      })
      if (mentions.length > params.mentionLimit) {
        mentions.length = params.mentionLimit
        truncated = true
      }

      const private_sessions = Array.from(privateSessionMap.values())
        .sort((a, b) => {
          if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
          return a.session_id.localeCompare(b.session_id)
        })
      const private_segments = [...privateSegments]
        .sort((a, b) => {
          if (a.start_ts !== b.start_ts) return a.start_ts - b.start_ts
          if (a.session_id !== b.session_id) return a.session_id.localeCompare(b.session_id)
          return a.segment_index - b.segment_index
        })
      const mention_groups = Array.from(mentionGroupsMap.values())
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count
          if (b.latest_ts !== a.latest_ts) return b.latest_ts - a.latest_ts
          return a.session_id.localeCompare(b.session_id)
        })

      const private_inbound_people = private_sessions.filter((item) => item.incoming_count > 0).length
      const private_replied_people = private_sessions.filter((item) => item.replied).length
      const private_outbound_people = private_sessions.filter((item) => item.outgoing_count > 0).length
      const mention_count = mention_groups.reduce((sum, item) => sum + item.count, 0)
      const mention_group_count = mention_groups.length

      const summary: MyFootprintSummary = {
        private_inbound_people,
        private_replied_people,
        private_outbound_people,
        private_reply_rate: private_inbound_people > 0 ? private_replied_people / private_inbound_people : 0,
        mention_count,
        mention_group_count
      }

      const diagnostics: MyFootprintDiagnostics = {
        truncated,
        scanned_dbs: 0,
        elapsed_ms: Math.max(0, Date.now() - startedAt)
      }

      return {
        success: true,
        data: {
          summary,
          private_sessions,
          private_segments,
          mentions,
          mention_groups,
          diagnostics
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

async enrichMyFootprintData(data: MyFootprintData): Promise<MyFootprintData> {
    try {
      const sessionIds = Array.from(new Set([
        ...data.private_sessions.map((item) => item.session_id),
        ...data.private_segments.map((item) => item.session_id),
        ...data.mention_groups.map((item) => item.session_id),
        ...data.mentions.map((item) => item.session_id)
      ].filter(Boolean)))
      const senderUsernames = Array.from(new Set(
        data.mentions
          .map((item) => item.sender_username)
          .filter((value) => String(value || '').trim())
      ))

      const usernames = Array.from(new Set([...sessionIds, ...senderUsernames]))
      if (usernames.length === 0) return data

      const enrichResult = await this.host.enrichSessionsContactInfo(usernames)
      if (!enrichResult.success || !enrichResult.contacts) return data
      const contacts = enrichResult.contacts

      const nextPrivateSessions = data.private_sessions.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })
      const nextPrivateSegments = data.private_segments.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })

      const nextMentionGroups = data.mention_groups.map((item) => {
        const contact = contacts[item.session_id]
        return {
          ...item,
          displayName: contact?.displayName || item.displayName,
          avatarUrl: contact?.avatarUrl || item.avatarUrl
        }
      })

      const nextMentions = await Promise.all(data.mentions.map(async (item) => {
        const sessionContact = contacts[item.session_id]
        const senderContact = item.sender_username ? contacts[item.sender_username] : undefined

        let normalizedContent = this.normalizeMyFootprintMentionContent(item.message_content)
        if (this.isLikelyUnreadableFootprintContent(normalizedContent) && item.session_id && item.local_id > 0) {
          const detailResult = await this.host.getMessageById(item.session_id, item.local_id)
          if (detailResult.success && detailResult.message) {
            const detailMessage = detailResult.message
            const detailRaw = String(
              detailMessage.rawContent
              || detailMessage.content
              || detailMessage.parsedContent
              || ''
            )
            const resolvedFromDetail = this.normalizeMyFootprintMentionContent(detailRaw)
            if (resolvedFromDetail && !this.isLikelyUnreadableFootprintContent(resolvedFromDetail)) {
              normalizedContent = resolvedFromDetail
            } else {
              const parsedFallback = String(detailMessage.parsedContent || '').trim()
              if (parsedFallback && !this.isLikelyUnreadableFootprintContent(parsedFallback)) {
                normalizedContent = parsedFallback
              }
            }
          }
        }

        return {
          ...item,
          message_content: normalizedContent,
          sessionDisplayName: sessionContact?.displayName || item.sessionDisplayName,
          senderDisplayName: senderContact?.displayName || item.senderDisplayName || item.sender_username,
          senderAvatarUrl: senderContact?.avatarUrl || item.senderAvatarUrl
        }
      }))

      return {
        ...data,
        private_sessions: nextPrivateSessions,
        private_segments: nextPrivateSegments,
        mention_groups: nextMentionGroups,
        mentions: nextMentions
      }
    } catch (error) {
      console.error('[ChatService] 补充我的足迹展示信息失败:', error)
      return data
    }
  }

normalizeMyFootprintMentionContent(rawContent: unknown): string {
    const decodedRaw = decodeMaybeCompressed(rawContent, 'footprint_message_content')
    let content = String(decodedRaw || rawContent || '')
    if (!content) return ''

    content = cleanUtf16(decodeHtmlEntities(content)).trim()
    if (!content) return ''

    const looksLikeXml = content.includes('<appmsg')
      || content.includes('&lt;appmsg')
      || content.includes('<msg')
      || content.includes('&lt;msg')

    if (looksLikeXml) {
      const xml = decodeHtmlEntities(content)
      const type49Info = parseType49Message(xml)

      if (type49Info.appMsgKind === 'quote') {
        const title = stripSenderPrefix(extractXmlValue(xml, 'title'))
        const quotedSender = String(type49Info.quotedSender || '').trim()
        const quotedContent = sanitizeQuotedContent(String(type49Info.quotedContent || '').trim())
        if (title) {
          if (quotedContent) {
            return `${title}\n\n引用：${quotedSender ? `${quotedSender}：` : ''}${quotedContent}`
          }
          return title
        }
        if (quotedContent) {
          return quotedSender ? `${quotedSender}：${quotedContent}` : quotedContent
        }
      }

      const parsed = parseMessageContent(xml, 49)
      const normalizedParsed = stripSenderPrefix(String(parsed || '').trim())
      if (normalizedParsed && normalizedParsed !== '[链接]' && normalizedParsed !== '[消息]') {
        return normalizedParsed
      }

      const xmlTitle = stripSenderPrefix(extractXmlValue(xml, 'title'))
      if (xmlTitle) return xmlTitle
    }

    return stripSenderPrefix(content)
  }

isLikelyUnreadableFootprintContent(content: string): boolean {
    const text = String(content || '').trim()
    if (!text) return false
    const compact = compactEncodedPayload(text)
    if (compact.length <= 80) return false
    if (looksLikeHex(compact)) return true
    if (looksLikeBase64(compact) && !compact.includes('<') && !compact.includes('>')) return true
    return false
  }

formatFootprintTime(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
    const date = new Date(timestamp * 1000)
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    const hh = `${date.getHours()}`.padStart(2, '0')
    const mm = `${date.getMinutes()}`.padStart(2, '0')
    const ss = `${date.getSeconds()}`.padStart(2, '0')
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
  }

escapeCsvCell(value: unknown): string {
    const text = String(value ?? '')
    if (!text) return ''
    if (!/[",\n\r]/.test(text)) return text
    return `"${text.replace(/"/g, '""')}"`
  }

buildMyFootprintCsv(data: MyFootprintData): string {
    const lines: string[] = []
    const pushRow = (...columns: unknown[]) => {
      lines.push(columns.map((value) => this.escapeCsvCell(value)).join(','))
    }

    pushRow('模块', '指标', '数值')
    pushRow('summary', '私聊找我人数', data.summary.private_inbound_people)
    pushRow('summary', '我回复人数', data.summary.private_replied_people)
    pushRow('summary', '我主动联系人数', data.summary.private_outbound_people)
    pushRow('summary', '私聊回复率', data.summary.private_reply_rate)
    pushRow('summary', '@我次数', data.summary.mention_count)
    pushRow('summary', '@我群聊数', data.summary.mention_group_count)
    pushRow('summary', '诊断:是否截断', data.diagnostics.truncated ? 'true' : 'false')
    pushRow('summary', '诊断:扫描分库数', data.diagnostics.scanned_dbs)
    pushRow('summary', '诊断:耗时ms', data.diagnostics.elapsed_ms)

    lines.push('')
    pushRow('private_sessions', 'session_id', 'display_name', 'incoming_count', 'outgoing_count', 'replied', 'first_incoming_ts', 'first_reply_ts', 'latest_ts', 'anchor_local_id', 'anchor_create_time')
    for (const row of data.private_sessions) {
      pushRow(
        'private_sessions',
        row.session_id,
        row.displayName || '',
        row.incoming_count,
        row.outgoing_count,
        row.replied ? 'true' : 'false',
        this.formatFootprintTime(row.first_incoming_ts),
        this.formatFootprintTime(row.first_reply_ts),
        this.formatFootprintTime(row.latest_ts),
        row.anchor_local_id,
        row.anchor_create_time
      )
    }

    lines.push('')
    pushRow(
      'private_segments',
      'session_id',
      'display_name',
      'segment_index',
      'start_ts',
      'end_ts',
      'duration_sec',
      'incoming_count',
      'outgoing_count',
      'message_count',
      'replied',
      'first_incoming_ts',
      'first_reply_ts',
      'latest_ts',
      'anchor_local_id',
      'anchor_create_time'
    )
    for (const row of data.private_segments) {
      pushRow(
        'private_segments',
        row.session_id,
        row.displayName || '',
        row.segment_index,
        this.formatFootprintTime(row.start_ts),
        this.formatFootprintTime(row.end_ts),
        row.duration_sec,
        row.incoming_count,
        row.outgoing_count,
        row.message_count,
        row.replied ? 'true' : 'false',
        this.formatFootprintTime(row.first_incoming_ts),
        this.formatFootprintTime(row.first_reply_ts),
        this.formatFootprintTime(row.latest_ts),
        row.anchor_local_id,
        row.anchor_create_time
      )
    }

    lines.push('')
    pushRow('mentions', 'session_id', 'session_display_name', 'local_id', 'create_time', 'sender_username', 'sender_display_name', 'message_content', 'source')
    for (const row of data.mentions) {
      pushRow(
        'mentions',
        row.session_id,
        row.sessionDisplayName || '',
        row.local_id,
        this.formatFootprintTime(row.create_time),
        row.sender_username,
        row.senderDisplayName || '',
        row.message_content,
        row.source
      )
    }

    lines.push('')
    pushRow('mention_groups', 'session_id', 'display_name', 'count', 'latest_ts')
    for (const row of data.mention_groups) {
      pushRow(
        'mention_groups',
        row.session_id,
        row.displayName || '',
        row.count,
        this.formatFootprintTime(row.latest_ts)
      )
    }

    return lines.join('\n')
  }
}
