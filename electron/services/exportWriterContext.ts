import type {
  ExportCollectResult,
  ExportCollectedRow,
  ExportDisplayProfile,
  ExportOptions,
  ExportProgress,
  ExportTaskControl,
} from './exportServiceTypes'

/** Methods on ExportService that format writers delegate to at runtime. */
export interface ExportWriterHost {
  appendTransferDesc(...args: any[]): any
  applyExcelLinkCardCell(...args: any[]): any
  batchSize(...args: any[]): any
  buildExportStatsCacheKey(...args: any[]): any
  buildFileOnlyExportFailure(...args: any[]): any
  buildNoMessagesError(...args: any[]): any
  buildQuotedReplyText(...args: any[]): any
  buildSessionExportBaseName(...args: any[]): any
  clearMediaRuntimeState(...args: any[]): any
  cloneExportStatsResult(...args: any[]): any
  collectMediaMessagesForExport(messages: ExportCollectedRow[], options: ExportOptions): ExportCollectedRow[]
  collectMessages(...args: any[]): Promise<ExportCollectResult>
  container(...args: any[]): any
  convertMessageType(localType: number, content: string): number
  createCollectProgressReporter(...args: any[]): any
  createProgressEmitter(...args: any[]): any
  data(...args: any[]): any
  ensureConnected(...args: any[]): any
  ensureExportDir(...args: any[]): any
  ensureVoiceModel(...args: any[]): any
  escapeAttribute(...args: any[]): any
  escapeCsvCell(...args: any[]): any
  exportAvatars(...args: any[]): any
  exportAvatarsToFiles(...args: any[]): any
  exportMediaForMessage(...args: any[]): any
  exportSessionToChatLab(...args: any[]): any
  exportSessionToDetailedJson(...args: any[]): any
  exportSessionToExcel(...args: any[]): any
  exportSessionToExcelStreaming(...args: any[]): any
  exportSessionToHtml(...args: any[]): any
  exportSessionToTxt(...args: any[]): any
  exportSessionToWeCloneCsv(...args: any[]): any
  extractArkmeAppMessageMeta(...args: any[]): any
  extractArkmeContactCardMeta(...args: any[]): any
  extractChatLabReplyToMessageId(...args: any[]): any
  extractGroupSenderCountMap(...args: any[]): any
  extractHtmlLinkCard(...args: any[]): any
  extractReadableSystemMessageText(...args: any[]): any
  formatIsoTimestamp(...args: any[]): any
  formatHtmlMessageText(...args: any[]): any
  formatLinkCardExportText(...args: any[]): any
  formatMediaPhaseLabel(...args: any[]): any
  formatPlainExportContent(...args: any[]): any
  formatTimestamp(...args: any[]): any
  getAggregatedSessionStatsCache(...args: any[]): any
  getAvatarFallback(...args: any[]): any
  getConfiguredMyWxid(...args: any[]): any
  getContactInfo(...args: any[]): any
  getExportMeta(...args: any[]): any
  getExportPlatformMessageId(...args: any[]): any
  getExportReplyToMessageId(...args: any[]): any
  getExportStatsCacheEntry(...args: any[]): any
  getGroupNicknamesForRoom(...args: any[]): any
  getMediaDoneFilesCount(...args: any[]): any
  getMediaLayout(...args: any[]): any
  getMediaTelemetrySnapshot(...args: any[]): any
  getMessageTypeName(...args: any[]): any
  getPreferredDisplayName(...args: any[]): any
  getSessionFilePrefix(...args: any[]): any
  getWeCloneSource(...args: any[]): any
  getWeCloneTypeName(...args: any[]): any
  getWeflowHeader(...args: any[]): any
  hydrateEmojiCaptionsForMessages(...args: any[]): any
  isMediaContentBatchExport(...args: any[]): any
  isQuotedReplyMessage(...args: any[]): any
  isReadableSystemMessage(localType: number, content: string): boolean
  isSameWxid(...args: any[]): any
  isTransferExportContent(...args: any[]): any
  isUnboundedDateRange(...args: any[]): any
  list(...args: any[]): any
  loadExportHtmlStyles(...args: any[]): any
  loading(...args: any[]): any
  mergeGroupMembers(...args: any[]): any
  normalizeExportOptionsForRun(...args: any[]): any
  normalizeFileNamingMode(...args: any[]): any
  observer(...args: any[]): any
  parseMessageContent(...args: any[]): any
  preloadContactInfos(...args: any[]): any
  preloadContacts(...args: any[]): any
  preloadMediaLookupCaches(...args: any[]): any
  preloadVoiceWavCache(...args: any[]): any
  queryFriendFlagMap(...args: any[]): any
  recordCreatedFileBeforeWrite(...args: any[]): any
  renderBatch(...args: any[]): any
  renderItem(...args: any[]): any
  renderTextWithEmoji(...args: any[]): any
  rendered(...args: any[]): any
  reserveUniqueOutputPath(...args: any[]): any
  resetMediaRuntimeState(...args: any[]): any
  resolveCollectParams(...args: any[]): any
  resolveExportDisplayProfile(
    wxid: string,
    preference: ExportOptions['displayNamePreference'],
    getContact: (username: string) => Promise<{ success: boolean; contact?: any; error?: string }>,
    groupNicknamesMap: Map<string, string>,
    fallbackDisplayName?: string,
    extraGroupNicknameCandidates?: Array<string | undefined | null>
  ): Promise<ExportDisplayProfile>
  resolveExportWriteLayout(...args: any[]): any
  resolveGroupNicknameByCandidates(groupNicknamesMap: Map<string, string>, candidates: Array<string | undefined | null>): string
  resolveQuotedMessagesForExport(...args: any[]): any
  resolveQuotedReplyDisplayWithNames(...args: any[]): any
  resolveTransferDesc(...args: any[]): any
  sentinel(...args: any[]): any
  setAggregatedSessionStatsCache(...args: any[]): any
  setExportStatsCacheEntry(...args: any[]): any
  sumSenderCountsByIdentity(...args: any[]): any
  throwIfStopRequested(control?: ExportTaskControl): void
  transcribeVoice(...args: any[]): any
  triggerMediaFileCacheCleanup(...args: any[]): any
}

export type { ExportCollectedRow, ExportCollectResult }
