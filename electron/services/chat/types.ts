export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  messageCountHint?: number
  displayName?: string
  avatarUrl?: string
  lastMsgSender?: string
  lastSenderDisplayName?: string
  selfWxid?: string
  isFolded?: boolean  // 是否已折叠进"折叠的群聊"
  isMuted?: boolean   // 是否开启免打扰
}

export interface Message {
  messageKey: string
  localId: number
  serverId: number
  serverIdRaw?: string
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent?: string
  content?: string  // 原始XML内容（与rawContent相同，供前端使用）
  emojiCdnUrl?: string
  emojiMd5?: string
  emojiLocalPath?: string
  emojiThumbUrl?: string
  emojiEncryptUrl?: string
  emojiAesKey?: string
  quotedContent?: string
  quotedSender?: string
  imageMd5?: string
  imageOriginSourceMd5?: string
  imageDatName?: string
  videoMd5?: string
  aesKey?: string
  encrypVer?: number
  cdnThumbUrl?: string
  voiceDurationSeconds?: number
  linkTitle?: string
  linkUrl?: string
  linkThumb?: string
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
  xmlType?: string
  appMsgKind?: string
  appMsgDesc?: string
  appMsgAppName?: string
  appMsgSourceName?: string
  appMsgSourceUsername?: string
  appMsgThumbUrl?: string
  appMsgMusicUrl?: string
  appMsgDataUrl?: string
  appMsgLocationLabel?: string
  finderNickname?: string
  finderUsername?: string
  finderCoverUrl?: string
  finderAvatar?: string
  finderDuration?: number
  locationLat?: number
  locationLng?: number
  locationPoiname?: string
  locationLabel?: string
  musicAlbumUrl?: string
  musicUrl?: string
  giftImageUrl?: string
  giftWish?: string
  giftPrice?: string
  cardUsername?: string
  cardNickname?: string
  cardAvatarUrl?: string
  transferPayerUsername?: string
  transferReceiverUsername?: string
  chatRecordTitle?: string
  chatRecordList?: Array<{
    datatype: number
    sourcename: string
    sourcetime: string
    sourceheadurl?: string
    datadesc?: string
    datatitle?: string
    fileext?: string
    datasize?: number
    messageuuid?: string
    dataurl?: string
    datathumburl?: string
    datacdnurl?: string
    cdndatakey?: string
    cdnthumbkey?: string
    aeskey?: string
    md5?: string
    fullmd5?: string
    thumbfullmd5?: string
    srcMsgLocalid?: number
    imgheight?: number
    imgwidth?: number
    duration?: number
    chatRecordTitle?: string
    chatRecordDesc?: string
    chatRecordList?: any[]
  }>
  _db_path?: string
}

export type ResourceMessageType = 'image' | 'video' | 'voice' | 'file'

export interface ResourceMessageItem extends Message {
  sessionId: string
  sessionDisplayName?: string
  resourceType: ResourceMessageType
}

export interface Contact {
  username: string
  alias: string
  remark: string
  nickName: string
}

export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  alias?: string
  labels?: string[]
  detailDescription?: string
  region?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'former_friend' | 'other'
}

export interface GetContactsOptions {
  lite?: boolean
}

export interface ExportSessionStats {
  totalMessages: number
  voiceMessages: number
  imageMessages: number
  videoMessages: number
  emojiMessages: number
  transferMessages: number
  redPacketMessages: number
  callMessages: number
  firstTimestamp?: number
  lastTimestamp?: number
  privateMutualGroups?: number
  groupMemberCount?: number
  groupMyMessages?: number
  groupActiveSpeakers?: number
  groupMutualFriends?: number
}

export interface ExportSessionStatsOptions {
  includeRelations?: boolean
  forceRefresh?: boolean
  allowStaleCache?: boolean
  preferAccurateSpecialTypes?: boolean
  cacheOnly?: boolean
  beginTimestamp?: number
  endTimestamp?: number
}

export interface ExportSessionStatsCacheMeta {
  updatedAt: number
  stale: boolean
  includeRelations: boolean
  source: 'memory' | 'disk' | 'fresh'
}

export interface ExportTabCounts {
  private: number
  group: number
  official: number
  former_friend: number
}

export interface SessionDetailFast {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
}

export interface SessionDetailExtra {
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

export type SessionDetail = SessionDetailFast & SessionDetailExtra

export interface SyntheticUnreadState {
  readTimestamp: number
  scannedTimestamp: number
  latestTimestamp: number
  unreadCount: number
  summaryTimestamp?: number
  summary?: string
  lastMsgType?: number
}

export interface MyFootprintSummary {
  private_inbound_people: number
  private_replied_people: number
  private_outbound_people: number
  private_reply_rate: number
  mention_count: number
  mention_group_count: number
}

export interface MyFootprintPrivateSession {
  session_id: string
  incoming_count: number
  outgoing_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

export interface MyFootprintPrivateSegment {
  session_id: string
  segment_index: number
  start_ts: number
  end_ts: number
  duration_sec: number
  incoming_count: number
  outgoing_count: number
  message_count: number
  replied: boolean
  first_incoming_ts: number
  first_reply_ts: number
  latest_ts: number
  anchor_local_id: number
  anchor_create_time: number
  displayName?: string
  avatarUrl?: string
}

export interface MyFootprintMentionItem {
  session_id: string
  local_id: number
  create_time: number
  sender_username: string
  message_content: string
  source: string
  sessionDisplayName?: string
  senderDisplayName?: string
  senderAvatarUrl?: string
}

export interface MyFootprintMentionGroup {
  session_id: string
  count: number
  latest_ts: number
  displayName?: string
  avatarUrl?: string
}

export interface MyFootprintDiagnostics {
  truncated: boolean
  scanned_dbs: number
  elapsed_ms: number
  mention_truncated?: boolean
  private_truncated?: boolean
  native_ms?: number
  source_filter_ms?: number
  fallback_ms?: number
  enrich_ms?: number
  pipeline_ms?: number
  fallback_used?: boolean
  private_limit_effective?: number
  mention_candidate_limit?: number
  native_mention_candidates?: number
  source_filtered_mentions?: number
  private_session_count?: number
  group_session_count?: number
  native_passes?: number
  native_group_chunks?: number
}

export interface MyFootprintData {
  summary: MyFootprintSummary
  private_sessions: MyFootprintPrivateSession[]
  private_segments: MyFootprintPrivateSegment[]
  mentions: MyFootprintMentionItem[]
  mention_groups: MyFootprintMentionGroup[]
  diagnostics: MyFootprintDiagnostics
}
