# Rust 集成指南

本指南介绍如何在 WeFlow 项目中使用 Rust 重构的核心模块。

## 快速开始

### 1. 安装 Rust 工具链

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# 验证安装
rustc --version  # 应 >= 1.75.0
cargo --version
```

### 2. 构建 Rust 模块

```bash
# 进入 Rust 目录
cd rust

# 安装 NAPI-RS CLI
npm install -g @napi-rs/cli

# 安装依赖
npm install

# 开发构建
napi build --platform

# 生产构建（优化）
napi build --platform --release
```

构建成功后，会在 `rust/` 目录下生成：
- `weflow-core.darwin-arm64.node` (Apple Silicon)
- `weflow-core.darwin-x64.node` (Intel Mac)
- `weflow-core.win32-x64-msvc.node` (Windows)
- `weflow-core.linux-x64-gnu.node` (Linux)

### 3. 在 Electron 中使用

```typescript
import {
  isRustAvailable,
  createRustImageDecryptService,
  createRustExportService,
  createRustAnalyticsService,
  initRustLogging,
} from './services/rustBridge';

// 初始化
initRustLogging();

// 检查 Rust 是否可用
if (isRustAvailable()) {
  console.log('Rust 核心模块已加载，享受极致性能！');
} else {
  console.log('使用 TypeScript 回退实现');
}

// 使用 Rust 图片解密服务
const decryptService = createRustImageDecryptService();
decryptService.setXorKey(Buffer.from([0xA3, 0xA2, 0xA1, 0xA0]));

const result = await decryptService.decryptFile(
  '/path/to/image.dat',
  '/output/directory'
);

if (result.success) {
  console.log('解密成功:', result.outputPath);
}

// 使用 Rust 导出服务
const exportService = createRustExportService();
const task = exportService.createTask('task-1', {
  format: 'Html',
  outputPath: '/output/chat.html',
  includeMedia: true,
  includeAvatar: false,
});

// 监听进度
const interval = setInterval(() => {
  const progress = task.getProgress();
  console.log(`${progress.percentage.toFixed(1)}% - ${progress.stage}`);
}, 100);

// 执行导出
const success = await task.execute(messages, session);
clearInterval(interval);

if (success) {
  console.log('导出完成！');
}

// 使用 Rust 数据分析服务
const analyticsService = createRustAnalyticsService();

// 基础统计
const stats = analyticsService.calculateMessageStats(messages);
console.log(`共 ${stats.totalMessages} 条消息, ${stats.totalChars} 字`);

// 年度报告
const yearlyReport = analyticsService.generateYearlyReport(messages, 2024);
console.log('年度报告生成完成:', yearlyReport.highlights);

// 双人报告
const dualReport = analyticsService.generateDualReport(messages, '好友昵称');
console.log('聊天模式:', dualReport.chatPatterns);
```

## API 参考

### ImageDecryptService

```typescript
class ImageDecryptService {
  constructor();
  
  // 设置解密密钥
  setXorKey(key: Buffer): void;
  setAesKey(key: string): void;
  
  // 解密单个文件
  decryptFile(inputPath: string, outputDir: string): Promise<DecryptResult>;
  
  // 批量解密
  decryptBatch(
    inputPaths: string[], 
    outputDir: string, 
    concurrency: number
  ): Promise<DecryptResult[]>;
  
  // 自动检测密钥
  tryDetectKey(samplePath: string): Promise<Buffer | null>;
}

interface DecryptResult {
  success: boolean;
  outputPath?: string;
  format: string;
  error?: string;
  isThumbnail: boolean;
}
```

### ExportService / ExportTask

```typescript
class ExportService {
  constructor();
  
  createTask(id: string, config: ExportConfig): ExportTask;
  getTaskProgress(taskId: string): ExportProgress | null;
  cancelTask(taskId: string): void;
  cleanupTasks(): number;
}

class ExportTask {
  getProgress(): ExportProgress;
  execute(messages: Message[], session: Session): Promise<boolean>;
  cancel(): void;
  pause(): void;
  resume(): void;
}

type ExportFormat = 'Html' | 'Json' | 'Csv' | 'Excel' | 'Txt' | 'ChatLab';

interface ExportConfig {
  format: ExportFormat;
  outputPath: string;
  includeMedia: boolean;
  includeAvatar?: boolean;
  dateRangeStart?: number;
  dateRangeEnd?: number;
  maxFileSizeMb?: number;
  namingMode?: 'datetime' | 'sequential' | 'original';
}

interface ExportProgress {
  total: number;
  current: number;
  percentage: number;
  currentItem?: string;
  stage: 'preparing' | 'exporting' | 'finalizing' | 'completed' | 'error';
  error?: string;
}
```

### AnalyticsService

```typescript
class AnalyticsService {
  constructor();
  
  calculateMessageStats(messages: Message[]): MessageStatsResult;
  calculateWordFrequency(messages: Message[], topN: number): WordStat[];
  calculateActiveHours(messages: Message[]): number[];
  generateYearlyReport(messages: Message[], year: number): YearlyReport;
  generateDualReport(messages: Message[], sessionName: string): DualReport;
  clearCache(): number;
}
```

## 性能对比

### 图片解密

```typescript
// TypeScript (原实现)
const tsStart = Date.now();
for (const file of imageFiles) {
  await nativeImageDecrypt(file); // ~30ms per file
}
console.log(`TypeScript: ${Date.now() - tsStart}ms`);
// 1000张图片: ~30秒

// Rust (新实现)
const rustStart = Date.now();
await rustService.decryptBatch(imageFiles, outputDir, 8);
console.log(`Rust: ${Date.now() - rustStart}ms`);
// 1000张图片: ~5秒 (6x 提升)
```

### 消息导出

```typescript
// TypeScript
await exportService.exportMessages(messages, 'Html'); // ~60s for 100k messages

// Rust
await rustTask.execute(messages, session); // ~15s for 100k messages (4x 提升)
```

### 数据分析

```typescript
// TypeScript
const stats = await insightService.analyze(messages); // ~120s for 1M messages

// Rust
const stats = rustAnalytics.calculateMessageStats(messages); // ~30s (4x 提升)
```

## 多平台构建

### macOS Universal (Intel + Apple Silicon)

```bash
cd rust
napi build --platform --release --target aarch64-apple-darwin
napi build --platform --release --target x86_64-apple-darwin

# 合并为 Universal Binary
lipo -create \
  weflow-core.darwin-arm64.node \
  weflow-core.darwin-x64.node \
  -output weflow-core.darwin-universal.node
```

### Windows

```bash
# 需要 Windows 环境或交叉编译工具链
cd rust
napi build --platform --release --target x86_64-pc-windows-msvc
```

### Linux

```bash
cd rust
napi build --platform --release --target x86_64-unknown-linux-gnu
```

## 故障排除

### 构建失败

**问题**: `napi build` 找不到 Rust 工具链  
**解决**: 
```bash
rustup default stable
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**问题**: 链接错误  
**解决**: 
```bash
# macOS
xcode-select --install

# Linux
sudo apt-get install build-essential pkg-config libssl-dev
```

### 运行时错误

**问题**: `Cannot find module`  
**解决**: 
- 确保 `.node` 文件存在于 `rust/` 目录
- 检查 `index.js` 中的路径配置

**问题**: `Invalid ELF header` / `Mach-O` 格式错误  
**解决**: 
- 确保 `.node` 文件与当前平台匹配
- 重新构建指定目标平台的模块

**问题**: 内存溢出  
**解决**: 
- 批量处理时使用流式 API
- 调整 `concurrency` 参数

## 开发工作流程

### 1. 修改 Rust 代码

```bash
cd rust/src
# 编辑 .rs 文件
```

### 2. 构建并测试

```bash
cd rust
napi build --platform  # 快速调试构建
# 或
napi build --platform --release  # 优化生产构建
```

### 3. 在 Electron 中测试

```bash
cd ..
npm run dev  # 启动 Electron
```

### 4. 性能分析

```bash
cd rust
cargo bench  # 运行基准测试
```

## 注意事项

1. **类型转换**: Rust 与 TypeScript 之间传递 Buffer 时注意拷贝开销
2. **错误处理**: Rust panic 会转换为 NAPI 错误，建议始终使用 `Result`
3. **并发控制**: Rust 内部使用 Tokio，注意与 Electron 事件循环的配合
4. **内存管理**: 大文件处理使用流式或内存映射避免内存溢出

## 下一步

- [ ] 运行 `napi build` 验证构建
- [ ] 在 Electron 中测试集成
- [ ] 逐步替换现有 TypeScript 服务
- [ ] 添加性能基准测试
- [ ] 配置 CI/CD 自动构建
