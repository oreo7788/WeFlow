# WeFlow 性能优化方案

## 背景

WeFlow 是 React + Electron 架构，聊天数据主要由 Electron 主进程访问 WCDB，再通过 IPC 返回给渲染进程。当前项目已经使用 `react-virtuoso`、消息缓存、Worker 化 WCDB 查询和部分媒体缓存机制，但在大数据量聊天记录、群聊、媒体消息、搜索和会话列表加载场景下，仍可能出现卡顿或响应延迟。

本文档基于当前代码结构梳理可落地的优化方向，目标是先定位真实瓶颈，再按收益和风险分阶段优化。

## 当前主要瓶颈

### 1. 聊天消息数组会持续增长

聊天页已经使用 `react-virtuoso` 做虚拟列表，但虚拟列表主要减少 DOM 节点数量，不能减少 JS 层数据维护成本。

当前消息会不断 prepend 到 Zustand store 的 `messages` 数组中。随着用户持续向上滚动，数组越来越大，相关成本也会增长：

- Zustand 状态更新成本增加。
- React diff 和 item key 计算成本增加。
- 消息去重 alias index 维护成本增加。
- 内存占用持续增长。

相关位置：

- `src/pages/ChatPage.tsx`
- `src/stores/chatStore.ts`

### 2. 单条消息气泡组件偏重

`MessageBubbleItem` 同时处理文本、图片、语音、视频、表情、引用、头像、发送者信息、图片解密、语音转写等逻辑。

媒体消息会引入多个运行时成本：

- `IntersectionObserver`
- `ResizeObserver`
- 图片解密状态
- 表情下载状态
- 语音加载和播放状态
- 引用消息解析和跳转逻辑

当可视区包含大量图片、表情或语音消息时，渲染进程主线程压力会明显增加。

相关位置：

- `src/pages/Chat/MessageBubbleItem.tsx`

### 3. 历史消息分页存在 offset/cursor skip 成本

历史消息加载使用 cursor 状态和 offset。当 offset 与 cursor 状态不一致时，会重新打开 cursor 并逐批 skip 到目标位置。

长会话、大群、频繁切会话或连续快速滚动时，这条路径容易放大延迟。

相关位置：

- `electron/services/chat/messageCursorService.ts`
- `electron/services/wcdbCore.ts`

### 4. 会话列表首屏加载偏重

会话列表加载后还会补联系人、补公众号、处理企业微信类型、计算公众号 synthetic unread 等信息。

这些数据对首屏展示不是全部必需，但会和首屏加载竞争主进程、WCDB 和渲染进程资源。

相关位置：

- `electron/services/chat/sessionListService.ts`
- `src/pages/ChatPage.tsx`

### 5. 群聊搜索存在 N+1 查询风险

群聊搜索结果如果缺少 sender 信息，会逐条调用 `getMessageById` 补详情。搜索结果较多时，会产生大量串行或半串行查询。

相关位置：

- `electron/services/chat/messageQueryService.ts`

### 6. 媒体资源页可能在 JS 侧扫描和排序

资源消息查询会按 session 和 type 扫描，再在 JS 侧聚合、去重、排序和分页。数据量较大时，这会造成明显 CPU 和内存压力。

相关位置：

- `electron/services/chat/mediaAssetsService.ts`

## 优化目标

### 短期目标

- 明确慢点来自 WCDB 查询、JSON 解析、IPC、React 渲染还是媒体处理。
- 降低长聊天记录滚动后的内存和渲染成本。
- 减少首屏切会话和加载历史消息的卡顿。

### 中期目标

- 将历史消息分页从 offset/cursor skip 改为 keyset pagination。
- 将搜索和统计中的 N+1 查询改为批量查询。
- 将会话列表首屏和后台增强数据彻底拆开。

### 长期目标

- 把媒体消息加载、解密、转码、转写做成更明确的异步队列。
- 建立稳定的性能指标和回归测试场景。
- 降低大数据量账号下的主线程压力和内存峰值。

## 推荐实施优先级

## P0：增加性能埋点

在动核心分页和渲染逻辑前，先补齐性能埋点，避免凭感觉优化。

建议埋点位置：

- `electron/services/wcdbCore.ts`
- `electron/services/chat/messageCursorService.ts`
- `electron/services/chat/sessionListService.ts`
- `electron/services/chat/messageQueryService.ts`
- `src/pages/ChatPage.tsx`
- `src/pages/Chat/MessageBubbleItem.tsx`
- `src/stores/chatStore.ts`

建议记录指标：

- native 查询耗时。
- JSON 字符串大小。
- JSON parse 耗时。
- IPC 往返耗时。
- `setMessages` / `appendMessages` 耗时。
- 单次加载更多返回条数和耗时。
- React 消息列表渲染耗时。
- 图片解密、表情下载、语音转码和语音转写耗时。

建议日志格式：

```text
[perf] area=chat action=getMessages session=xxx offset=0 limit=50 nativeMs=42 parseMs=8 totalMs=63 rows=50 jsonBytes=180234
```

注意事项：

- 默认只在开发环境或 debug 开关开启时输出。
- 日志要做采样或聚合，避免日志本身影响性能。
- 慢操作阈值建议从 50ms、100ms、300ms 三档开始。

## P1：限制聊天消息常驻窗口

当前 `messages` 会随历史加载持续增长。建议为单个会话设置常驻窗口上限，例如 500 条。

优化策略：

- 首屏仍加载最新 50-70 条。
- 向上加载历史消息时，prepend 新消息。
- 如果总数超过窗口上限，裁剪离当前视口最远的一端。
- 裁剪前记录边界锚点，用于继续加载。
- 日期跳转、引用跳转等场景可以临时提高窗口上限。

建议新增状态：

- `oldestAnchor`
- `newestAnchor`
- `trimmedBefore`
- `trimmedAfter`

预期收益：

- 长时间滚动后不再越来越卡。
- 降低 React diff 成本。
- 降低 Zustand store 大数组更新成本。
- 降低内存占用。

风险点：

- 滚动锚点需要处理好，否则会出现跳屏。
- 引用消息跳转可能跳到已裁剪区域，需要触发重新定位加载。
- 搜索定位和日期跳转要支持重建窗口。

## P2：历史分页改为 keyset pagination

offset 在长聊天记录中天然会变慢，cursor 状态一旦错位还会触发 skip。建议改成基于排序锚点的分页。

建议分页锚点字段：

- `createTime`
- `localId`
- `sortSeq`
- `_db_path`

加载更早消息时，传入当前最早消息的锚点：

```text
before = {
  createTime,
  localId,
  sortSeq,
  dbPath
}
```

native 层查询语义：

```text
返回排序位置早于 before 的 limit 条消息
```

加载更新消息时，传入当前最新消息的锚点：

```text
after = {
  createTime,
  localId,
  sortSeq,
  dbPath
}
```

预期收益：

- 加载历史消息不再受 offset 增长影响。
- 避免 cursor 重建后的批量 skip。
- 长聊天记录和大群分页更稳定。

实施建议：

- 先保留旧的 offset 接口作为 fallback。
- 新增 `getMessagesBefore` / `getMessagesAfter` 接口。
- 前端加载更多优先使用 keyset 接口。
- 稳定后再逐步减少 offset 路径依赖。

## P3：会话列表首屏轻量化

会话列表首屏只需要展示基础信息，不应等待所有增强数据。

首屏建议字段：

- `username`
- `displayName` fallback
- `summary`
- `sortTimestamp`
- `lastTimestamp`
- `unreadCount`
- 已命中的头像缓存

后台增强字段：

- 联系人昵称和备注。
- 头像。
- 企业微信类型。
- 公众号补齐。
- synthetic unread。
- 消息数量 hint。

优化策略：

- `getSessions` 只返回基础会话。
- `enrichSessionsContactInfo` 按可视区优先批量加载。
- 公众号补齐和 synthetic unread 放到后台任务。
- 后台更新要合批，避免频繁 `setSessions`。

预期收益：

- 数据库连接后的首页更快。
- 大账号会话列表加载更稳定。
- 滚动时减少联系人补齐对主线程的干扰。

## P4：搜索结果批量 hydrate

当前群聊搜索缺 sender 信息时，可能逐条 `getMessageById` 补详情。建议改为批量 hydrate 或让 native 搜索直接返回完整字段。

优化策略：

- 优先让 `searchMessages` 返回 sender、isSend、localType、rawContent、createTime 等完整字段。
- 如果 native 层暂时不能返回完整字段，新增批量接口：

```text
getMessagesByIds(sessionId, localIds[])
```

- 前端或 service 层一次性传入 localId 列表。
- 批量结果用 Map 回填搜索结果。

预期收益：

- 群聊搜索明显提速。
- 减少 IPC 次数。
- 减少 WCDB 查询次数。

## P5：拆分重型消息气泡

`MessageBubbleItem` 逻辑集中度较高，建议拆成按消息类型隔离的 memo 组件。

建议拆分：

- `TextMessageBubble`
- `ImageMessageBubble`
- `VoiceMessageBubble`
- `EmojiMessageBubble`
- `VideoMessageBubble`
- `QuotePreview`
- `SenderAvatar`

优化策略：

- 滚动中暂停非必要媒体检查。
- 仅进入视口后启动图片解密、高清检查和语音加载。
- 将 observer 管理集中化，减少每条消息独立创建 observer 的成本。
- 对纯文本消息走最轻渲染路径。
- 对媒体消息使用稳定 props，减少 memo 失效。

预期收益：

- 降低单条消息渲染成本。
- 降低滚动时主线程压力。
- 更容易定位具体消息类型的性能问题。

## P6：媒体资源查询下沉到 native 层

资源消息页不适合在 JS 侧扫描大量 session 后再排序分页。建议把筛选、排序和分页尽量放到 native/WCDB 层。

优化策略：

- native 层提供按资源类型分页查询。
- 支持 session、时间范围、类型过滤。
- 返回已经排序和分页后的结果。
- JS 层只做展示和轻量映射。

预期收益：

- 降低 JS CPU 和内存占用。
- 大账号资源页打开更快。
- 分页性能更稳定。

## 验证场景

每轮优化后建议固定测试以下场景：

- 冷启动并连接数据库。
- 打开最近聊天会话。
- 打开大群聊。
- 连续向上滚动 1000 条历史消息。
- 快速切换多个会话。
- 搜索群聊关键词。
- 打开包含大量图片、表情、语音的会话。
- 打开资源/媒体页。
- 打开群成员面板。
- 执行导出前统计。

建议记录指标：

- 冷启动到可操作耗时。
- 连接数据库耗时。
- 会话列表首屏耗时。
- 切会话首屏消息耗时。
- 单次加载更多耗时。
- 搜索首屏结果耗时。
- React commit 耗时。
- 渲染进程内存占用。
- 主进程 CPU 峰值。
- 渲染进程 CPU 峰值。

## 分阶段落地计划

### 第一阶段：观测和低风险优化

目标：

- 增加性能埋点。
- 给关键慢路径加耗时日志。
- 优化会话列表后台增强的合批更新。

建议改动：

- 增加统一 perf logger。
- 给 `getMessages`、`getLatestMessages`、`searchMessages`、`getSessions` 记录耗时。
- 给 `setMessages`、`appendMessages` 记录大数组更新耗时。
- 联系人增强更新合批并降低滚动期间优先级。

### 第二阶段：消息窗口上限

目标：

- 控制聊天页 `messages` 常驻数量。
- 解决越滚越卡和内存持续增长。

建议改动：

- 给消息 store 增加窗口裁剪能力。
- 加载更多后根据视口位置裁剪远端消息。
- 保存裁剪边界锚点。
- 引用跳转和日期跳转支持重新加载窗口。

### 第三阶段：keyset pagination

目标：

- 替换长 offset 和 cursor skip。
- 提升大聊天记录历史翻页稳定性。

建议改动：

- native 层新增锚点分页接口。
- Electron service 层新增 `getMessagesBefore` / `getMessagesAfter`。
- 前端加载更多改为优先锚点分页。
- 保留旧 offset 路径作为 fallback。

### 第四阶段：搜索和资源页批量化

目标：

- 减少 N+1 查询。
- 避免 JS 侧大规模扫描排序。

建议改动：

- 搜索结果完整字段返回。
- 增加批量 hydrate 接口。
- 资源消息查询下沉到 native 层。

### 第五阶段：消息气泡拆分

目标：

- 降低消息渲染复杂度。
- 降低滚动期间媒体消息开销。

建议改动：

- 按消息类型拆分组件。
- 纯文本消息走轻量路径。
- 媒体加载严格视口触发。
- 滚动中暂停非必要媒体检查。

## 风险和注意事项

- 消息窗口裁剪会影响引用跳转、日期跳转和搜索定位，需要统一处理重建窗口逻辑。
- keyset pagination 需要确认不同 message db 之间的全局排序稳定性。
- 会话列表首屏轻量化不能破坏现有搜索、折叠群和公众号入口逻辑。
- 媒体消息延迟加载不能影响用户点击查看原图、播放语音和导出场景。
- 性能日志必须可关闭，避免发布环境日志过多。

## 建议优先开始的改动

建议先做以下三项，收益较高且风险相对可控：

1. 增加性能埋点，确认真实瓶颈。
2. 限制聊天消息常驻窗口，控制长时间滚动后的内存和渲染成本。
3. 会话列表首屏轻量化，将联系人和统计增强彻底后台化。

完成这三项后，再推进 keyset pagination 和搜索批量化。
