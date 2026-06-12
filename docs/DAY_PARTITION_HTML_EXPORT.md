# WeFlow 按天分区 HTML 导出方案

## 1. 设计目标

### 1.1 要解决的问题

| 现状 | 目标 |
|------|------|
| 每次导出按时间范围重算，无法复用历史结果 | 未选中的日期文件保持不变 |
| HTML+媒体无会话级跳过 | 仅处理选中日期，工作量与天数成正比 |
| 单文件过大、重导慢 | 按天拆分，单日可独立重导 |
| 「最近 N 天」与增量语义混淆 | 明确为「按天更新 + 重建总览」 |

### 1.2 核心原则

1. **按天分区**：一天一个 HTML，是增量更新的最小单元
2. **manifest 驱动**：所有跳过/重建决策以 manifest 为准，不解析旧 HTML
3. **总 HTML 轻量重建**：`index.html` 只做汇总导航，不重复渲染全部消息
4. **媒体按天归属、全局可复用**：当天媒体放当天目录，跨天通过 mapping 去重
5. **兼容现有能力**：保留全量导出；按天模式作为 HTML+媒体的新增导出策略

### 1.3 典型使用场景

```
昨天：全量导出所有会话（HTML + 媒体）
今天：选择「最近 2~3 天」导出
  → 只重建选中日期范围内、且有变化的天 HTML
  → 重建 index.html 总览页
  → 其他天的文件保持不变
```

---

## 2. 目录结构

### 2.1 单会话导出包

媒体导出默认 `per-session` 布局，每个会话一个目录：

```
{outputDir}/
└── {sessionTypePrefix}{sessionName}/          # 例：群_家人群
    ├── index.html                             # 总览页（每次导出末尾重建）
    ├── manifest.json                          # 会话级清单（核心）
    ├── assets/                                # 共享静态资源（可选，Phase 2）
    │   ├── export.css
    │   └── export.js
    ├── days/
    │   ├── 2026-06-10.html                    # 日 HTML
    │   ├── 2026-06-11.html
    │   └── 2026-06-12.html
    ├── media/
    │   ├── 2026-06-10/                        # 当天媒体
    │   │   ├── img_12345_abc.jpg
    │   │   └── voice_12346_def.silk
    │   ├── 2026-06-11/
    │   └── shared/                            # 跨天复用的媒体硬链接（可选）
    └── .weflow/
        └── media-mapping.json                 # 全局媒体映射（扩展现有逻辑）
```

### 2.2 批量导出多会话

```
{outputDir}/
├── _batch-manifest.json                       # 可选：批量任务级汇总
├── 群_家人群/
│   ├── index.html
│   ├── manifest.json
│   └── days/...
├── 私_张三/
│   └── ...
└── 群_工作群/
    └── ...
```

### 2.3 与现有布局的关系

| 现有 `exportWriteLayout` | 按天方案 |
|--------------------------|----------|
| B（默认，outputDir 直下） | 会话目录直接在 outputDir 下 |
| A（texts/ 子目录） | 会话目录在 `texts/` 下，结构不变 |
| C（per-session） | 与按天方案天然兼容 |

**约定：** 按天 HTML 导出仅在 `exportMediaEnabled = true` 且 `format = html` 时启用；纯文本 HTML 可继续用单文件模式。

---

## 3. 核心数据模型

### 3.1 `manifest.json`（会话级）

```typescript
interface SessionExportManifest {
  version: 1
  schema: 'weflow-day-partition-v1'

  sessionId: string
  sessionName: string
  format: 'html'

  // 导出选项指纹：媒体开关、布局等变化 → 需全量重建
  optionsFingerprint: string

  // 时区：消息按天切分的依据（默认系统本地时区）
  timezone: string  // e.g. "Asia/Shanghai"

  // 总览页
  indexPath: 'index.html'
  indexGeneratedAt: number

  // 按天记录（key = YYYY-MM-DD）
  days: Record<string, DayManifestEntry>

  // 统计
  totalMessageCount: number
  totalMediaCount: number
  firstDay: string | null
  lastDay: string | null

  createdAt: number
  updatedAt: number
}

interface DayManifestEntry {
  day: string                    // YYYY-MM-DD
  htmlPath: string               // days/2026-06-12.html
  mediaDir: string               // media/2026-06-12/

  // 数据指纹（用于跳过判断）
  messageCount: number
  minCreateTime: number          // 当天最早消息（秒）
  maxCreateTime: number          // 当天最晚消息（秒）
  maxLocalId: number             // 同秒消歧

  mediaCount: number
  mediaFingerprint: string       // 媒体 key 集合 hash（可选）

  // 生成信息
  generatedAt: number
  durationMs: number
  status: 'fresh' | 'stale' | 'failed'

  // 来源
  lastRunMode: 'full' | 'day-rebuild' | 'day-skip'
}
```

### 3.2 消息按天切分规则

```typescript
function resolveMessageDay(createTimeSec: number, timezone: string): string {
  // createTime 统一为秒级时间戳
  // 转本地日期 YYYY-MM-DD
  return formatInTimeZone(createTimeSec * 1000, timezone, 'YYYY-MM-DD')
}
```

**边界约定：**

- 一天 = 本地时区 `[00:00:00, 23:59:59]`
- 与导出页「最近 N 天」、跳转日期使用同一时区逻辑
- `createTime` 归一化复用现有 `normalizeTimestampSeconds`

### 3.3 媒体映射（扩展 `media-mapping.json`）

```typescript
interface MediaMapping {
  version: 1
  sessionId: string
  entries: Record<string, MediaMappingEntry>
}

interface MediaMappingEntry {
  mediaKey: string              // `${localId}_${type}_${md5|path}`
  day: string                   // 归属天
  type: 'image' | 'video' | 'voice' | 'file' | 'emoji'
  sourceRef: string             // md5 / dat path
  destPath: string              // 相对路径 media/2026-06-12/xxx.jpg
  fileSize: number
  exportedAt: number
}
```

**复用规则：**

- 重建某天 HTML 时，先查 mapping
- `destPath` 文件存在 → 跳过解密，直接引用
- 不存在 → 解密/复制后更新 mapping

---

## 4. 导出模式定义

在导出页新增 **HTML 分区策略**（仅 HTML+媒体）：

```
HTML 导出策略：
  ○ 单文件（现有行为，兼容旧版）
  ● 按天分区（推荐，支持增量更新）
```

按天分区下再分三种运行模式：

| 模式 | 用户操作 | 系统行为 |
|------|----------|----------|
| **全量初始化** | 首次导出 / 无 manifest | 按消息日期范围生成所有天的 HTML + index |
| **按天更新** | 选「最近 2 天」/ 自定义日期 | 只重建选中天的 HTML，其余天不动 |
| **校验修复** | 勾选「校验并修复」 | 对比 DB 与 manifest，仅重建 `stale` 的天 |

### 4.1 与「时间范围」的关系

```
用户选择：最近 2 天（2026-06-11 ~ 2026-06-12）

→ targetDays = ['2026-06-11', '2026-06-12']

对每个会话：
  for day in targetDays:
    if manifest.days[day] 可跳过 → skip
    else → 重建 days/{day}.html
  重建 index.html（读取 manifest 全量 days，不扫库）
```

**语义说明：** 不是「自上次导出以来」，而是「**选中日期范围内，按天增量更新**」。

---

## 5. 完整导出流程

### 5.1 流程总览

```
开始导出
  ↓
manifest 存在？
  ├─ 否 → 全量初始化模式
  └─ 是 → optionsFingerprint 一致？
           ├─ 否 → 提示选项变更，需全量重建
           └─ 是 → 按天更新模式
  ↓
解析目标日期列表 targetDays
  ↓
逐会话处理
  ↓
逐目标日处理
  ├─ 该天可跳过 → 标记 day-skip
  └─ 不可跳过 → 采集当天消息 → 导出当天媒体 → 生成 days/YYYY-MM-DD.html
  ↓
更新 manifest.days
  ↓
重建 index.html
  ↓
完成
```

### 5.2 单天处理伪代码

```typescript
async function exportSessionDay(
  sessionId: string,
  day: string,
  sessionDir: string,
  manifest: SessionExportManifest,
  options: ExportOptions,
  control?: ExportTaskControl
): Promise<DayExportResult> {

  const dayStart = startOfDay(day, manifest.timezone)
  const dayEnd = endOfDay(day, manifest.timezone)

  // 1. DB 统计（轻量查询，不拉全量消息）
  const stats = await getDayMessageStats(sessionId, dayStart, dayEnd)

  // 2. 跳过判断
  const existing = manifest.days[day]
  if (existing && canSkipDay(existing, stats)) {
    return { day, mode: 'day-skip', messageCount: existing.messageCount }
  }

  // 3. 采集当天消息
  const collected = await collectMessages(
    sessionId, myWxid,
    { start: dayStart, end: dayEnd },
    options.senderUsername,
    collectMode, targetMediaTypes, control
  )

  if (collected.rows.length === 0) {
    await handleEmptyDay(sessionDir, day, manifest)
    return { day, mode: 'day-rebuild', messageCount: 0 }
  }

  // 4. 导出当天媒体（mapping 复用优先）
  const mediaResult = await exportDayMedia(
    sessionId, day, collected.rows, sessionDir, options, control
  )

  // 5. 生成日 HTML
  const htmlPath = path.join(sessionDir, 'days', `${day}.html`)
  await exportDayHtml(sessionId, day, collected, mediaResult, htmlPath, options)

  // 6. 更新 manifest
  manifest.days[day] = { /* ... */ }

  return { day, mode: 'day-rebuild', messageCount: collected.rows.length }
}
```

### 5.3 跳过判断 `canSkipDay`

```typescript
function canSkipDay(existing: DayManifestEntry, stats: DayStats): boolean {
  return (
    existing.status === 'fresh' &&
    existing.messageCount === stats.messageCount &&
    existing.maxCreateTime >= stats.maxCreateTime &&
    existing.maxLocalId >= stats.maxLocalId
  )
}
```

**说明：**

- 同一天内再次导出：若今天有新消息，`maxCreateTime` / `messageCount` 变化 → 只重导今天
- 昨天文件已稳定 → 自动跳过

### 5.4 总 HTML（`index.html`）重建

**设计原则：index 不嵌入消息，只读 manifest。**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>{sessionName} - 聊天记录总览</title>
  <style>/* 精简样式 */</style>
</head>
<body>
  <header>
    <h1>{sessionName}</h1>
    <p>共 {totalDays} 天 · {totalMessageCount} 条消息 · 更新于 {updatedAt}</p>
    <input id="daySearch" placeholder="搜索日期..." />
  </header>

  <main id="dayList">
    <!-- 由 manifest.days 按日期倒序生成 -->
    <a class="day-card" href="days/2026-06-12.html">
      <span class="date">2026-06-12</span>
      <span class="count">56 条</span>
      <span class="media">12 个媒体</span>
    </a>
  </main>

  <footer>
    <span>由 WeFlow 导出</span>
  </footer>
</body>
</html>
```

**重建成本：** 只读 `manifest.json` + 写 index，毫秒~秒级，与历史天数无关。

---

## 6. 日 HTML 设计

### 6.1 与现有单文件 HTML 的关系

复用现有 `exportHtmlWriter` 核心能力，入参改为「单日消息子集」：

| 组件 | 复用 |
|------|------|
| `collectMessages(dateRange=当天)` | ✅ |
| `exportMediaForMessage` / Rust 媒体 | ✅ |
| `WEFLOW_DATA` + `getVirtualScrollScript()` | ✅ |
| `EXPORT_HTML_STYLES` | ✅ |
| 页头 meta | 改为显示当天日期 |

### 6.2 日 HTML 页头

```html
<div class="header">
  <h1>{sessionName}</h1>
  <div class="meta">
    <span>2026-06-12</span>
    <span>{dayMessageCount} 条消息</span>
    <a href="../index.html">← 返回总览</a>
  </div>
</div>
```

### 6.3 媒体路径

日 HTML 内媒体使用相对路径：

```
days/2026-06-12.html  →  ../media/2026-06-12/img_xxx.jpg
```

### 6.4 Rust HTML 路径

消息数 ≥ 500 时，Rust 路径改为**按天调用**：

```typescript
await exportHtmlViaRust({
  outputPath: `days/${day}.html`,
  dateRange: { start: dayStart, end: dayEnd },
  includeMedia: true,
  ...
}, dayMessages)
```

---

## 7. 批量导出调度

### 7.1 任务拆分粒度

```
批量任务
  └── 会话任务（并发 2，与现有一致）
        └── 日任务（串行或低并发 1~2）
              ├── day-skip（即时完成）
              ├── day-rebuild（采集 + 媒体 + HTML）
              └── index-rebuild（每个会话末尾一次）
```

### 7.2 进度上报

```typescript
interface DayPartitionProgress {
  phase: 'day-skip' | 'day-rebuild' | 'index-rebuild' | 'complete'
  phaseLabel: string
  currentSession: string
  currentDay?: string
  daysTotal: number
  daysCompleted: number
  daysSkipped: number
  daysRebuilt: number
}
```

**示例文案：**

- `2026-06-11 无变化，已跳过`
- `正在重建 2026-06-12（56 条消息）`
- `正在生成总览页...`

### 7.3 性能预期

> 昨天全量 100 会话，今天「最近 2 天」

| 步骤 | 工作量 |
|------|--------|
| 100 会话 × 2 天 skip 检测 | ~200 次轻量 DB 统计 |
| 假设 80 会话昨天无变化 | 160 次 day-skip |
| 假设 20 会话今天有新消息 | 20 次 day-rebuild |
| 100 次 index 重建 | 极快 |

---

## 8. UI / 产品交互设计

### 8.1 导出页（HTML + 媒体）

```
格式：HTML

HTML 导出方式：
  ○ 单文件（兼容旧版）
  ● 按天分区（推荐，支持按天更新）

时间范围：
  [最近 3 天 ▼]  或  自定义起止日期

☑ 跳过未变化的天（推荐，默认开启）
☐ 校验并修复所有天（对比数据库，重建不一致的天）

说明：
  按天分区会将聊天记录按日期拆分为多个 HTML 文件，
  再次导出时仅重建选定日期范围内的天文件，并更新总览页。
  输出目录需与上次一致。
```

### 8.2 导出前预检（可选）

```
预检结果：
  可跳过：180 天次
  需重建：20 天次
  无 manifest 需初始化：4 个会话
预计耗时：约 3~8 分钟
```

### 8.3 自动化任务

定时任务默认：

- 策略：按天分区
- 范围：最近 3 天
- 跳过未变化的天：开启

---

## 9. API / 类型扩展

### 9.1 `ExportOptions` 新增字段

```typescript
interface ExportOptions {
  // ...现有字段

  /** HTML 分区策略 */
  htmlPartition?: 'single' | 'day'   // 默认 single，HTML+媒体推荐 day

  /** 按天模式下：是否跳过未变化的天 */
  skipUnchangedDays?: boolean        // 默认 true

  /** 按天模式下：是否校验修复所有天 */
  validateAllDays?: boolean          // 默认 false

  /** 显式目标日期列表（由 dateRange 解析而来） */
  targetDays?: string[]              // ['2026-06-11', '2026-06-12']
}
```

### 9.2 新增服务模块

```
electron/services/
  exportDayPartition/
    dayManifestService.ts      # manifest 读写、指纹、跳过判断
    dayRangeResolver.ts        # dateRange → targetDays[]
    dayHtmlExporter.ts         # 单日 HTML 导出（包装 exportHtmlMixin）
    dayMediaExporter.ts        # 单日媒体（扩展 media-mapping）
    indexHtmlGenerator.ts      # 总览页生成
    dayStatsService.ts         # 轻量按天 DB 统计
```

### 9.3 新增 DB 能力（建议）

```typescript
getSessionDayStats(
  sessionId: string,
  dayStart: number,
  dayEnd: number
): Promise<{
  messageCount: number
  maxCreateTime: number
  maxLocalId: number
}>
```

---

## 10. 边界情况处理

| 场景 | 策略 |
|------|------|
| 首次导出，历史 3 年消息 | 按消息实际跨度生成所有天；可分批（按月）避免一次过长 |
| 选中天内无消息 | 删除旧 `days/xxx.html` 或写空页；manifest 移除该天 |
| 用户删了 `days/` 下某天文件 | 校验模式：`htmlPath` 不存在 → `stale` → 重建 |
| 用户删了 manifest | 视为无 manifest，提示全量初始化 |
| 修改媒体开关 | `optionsFingerprint` 变化 → 强制全量重建所有天 |
| 更换输出目录 | 新目录无 manifest → 全量初始化 |
| 消息 `createTime` 被微信修正 | 校验模式对比 `messageCount`/`maxCreateTime` → 重建该天 |
| 跨年/跨月大量天文件 | index 按月分组展示；`days/2026/06/12.html`（Phase 2） |
| 单文件旧导出迁移 | 首次启用按天模式时提供「从单文件迁移」或重新全量 |

---

## 11. 与现有功能的关系

| 功能 | 按天方案下的行为 |
|------|------------------|
| `fileNamingMode: date-range` | 不再用于 HTML 按天模式（天即天然分区） |
| `fileNamingMode: classic` | 会话目录名仍用 classic |
| `exportRecordService` | 保留；manifest 为主，record 作辅助 |
| `media-mapping.json` | 迁入 `.weflow/`，扩展 `day` 字段 |
| 纯文本 JSON/Excel 导出 | 不受影响 |
| Rust HTML | 改为按天 batch 调用 |

---

## 12. 实施阶段

### Phase 1：基础骨架（1~2 周）

- [ ] `manifest.json` 读写
- [ ] `dateRange` → `targetDays[]`
- [ ] `getSessionDayStats` 轻量查询
- [ ] `canSkipDay` 跳过逻辑
- [ ] `indexHtmlGenerator`（纯 manifest 驱动）
- [ ] 导出页：`htmlPartition: 'day'` 开关

**验收：** 单会话全量生成 3 天文件 + index；第二次选 1 天，仅 1 天重建 + index 更新。

### Phase 2：日 HTML + 媒体（2 周）

- [ ] `dayHtmlExporter`（复用 `exportHtmlWriter`）
- [ ] `dayMediaExporter`（扩展 mapping，按天目录）
- [ ] Rust HTML 按天调用
- [ ] 批量导出接入 `exportSessionsWriter`
- [ ] 进度文案（day-skip / day-rebuild）

**验收：** 100 会话 × 最近 2 天，大量 day-skip；仅新消息天出现解密。

### Phase 3：体验与健壮性（1 周）

- [ ] 导出前预检
- [ ] 「校验并修复」模式
- [ ] 空天/失败天处理
- [ ] 自动化任务默认按天策略
- [ ] 旧单文件 HTML 兼容说明

### Phase 4：增强（可选）

- [ ] 共享 `assets/export.css/js`，日 HTML 瘦身
- [ ] index 全局搜索（加载各天 jsonl 索引）
- [ ] `days/2026/06/` 二级目录
- [ ] 月归档压缩

---

## 13. 推荐默认配置

```
格式：HTML
导出方式：按天分区
时间范围：最近 3 天
☑ 跳过未变化的天
输出目录：固定同一目录
命名：classic（会话目录名固定）
```

**用户操作流程：**

1. **第一次**：全量导出所有会话 → 生成所有历史天 + index（慢，一次性）
2. **之后每天**：选「最近 2~3 天」→ 只重建有变化的天 + 更新 index（快）

---

## 14. 与 checkpoint 增量方案对比

| 维度 | 按天分区方案（本方案） | checkpoint 增量 |
|------|------------------------|-----------------|
| 用户理解 | 「补最近几天」直观 | 「自上次导出以来」较抽象 |
| 与「最近 N 天」 | 天然匹配 | 需额外组合逻辑 |
| 未选中日期文件 | 明确不变 | 依赖检查点 |
| 同一天内多次导出 | 整天重导 | 可只导新增几条 |
| 总览单页体验 | index → 日 HTML 两级 | 单文件天然一体 |
| 实现复杂度 | 中等 | 中等 |

**结论：** 按天分区更适合「昨天全量、今天补最近几天」的场景；可与日内 checkpoint 组合使用。

---

## 15. 一句话总结

> **按天 HTML 是增量单元，manifest 是真相来源，index 是轻量汇总。**
> 导出 = 「选中天的重建」+ 「index 重生成」，其余文件原样保留。
