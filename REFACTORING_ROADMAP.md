# WeFlow Rust 重构路线图

## 重构目标

将 WeFlow 微信数据分析工具的核心性能模块从 TypeScript 重构为 Rust，实现 **4-10 倍的性能提升**，同时保持与现有 Electron 前端的无缝集成。

## 已完成 ✅

### 1. 基础架构
- [x] 创建 `rust/` 目录和项目结构
- [x] 配置 `Cargo.toml` 依赖（NAPI-RS, Tokio, 加密库, 数据库等）
- [x] 设置多平台构建配置（macOS Universal, Windows, Linux）
- [x] 创建 NAPI-RS 绑定层

### 2. 核心模块
- [x] **解密服务** (`crypto/`)
  - XOR/AES 图片解密
  - 密钥管理和派生
  - 并行批量解密

- [x] **数据库服务** (`db/`)
  - WCDB SQLite 连接管理
  - 数据模型定义
  - 查询构建器

- [x] **导出服务** (`export/`)
  - HTML 导出（带样式和消息渲染）
  - JSON/ChatLab 导出
  - CSV 导出
  - Excel 导出（待优化）
  - TXT 导出
  - 进度追踪和取消支持

- [x] **数据分析** (`analytics/`)
  - 基础消息统计
  - 词频分析
  - 活跃时间分布
  - 年度报告生成
  - 双人深度分析

- [x] **工具模块** (`utils/`)
  - 路径处理
  - 时间格式化
  - 文件操作

### 3. 集成文件
- [x] `index.js` - Node.js 模块加载器
- [x] `index.d.ts` - TypeScript 类型定义
- [x] `package.json` - NPM 配置
- [x] `build.rs` - Rust 构建脚本
- [x] `README.md` - 开发文档

## 待完成 📋

### 阶段 1：编译与测试（高优先级）
- [ ] 安装 Rust 工具链
- [ ] 安装 `napi-rs` CLI 工具
- [ ] 执行首次构建，修复编译错误
- [ ] 添加单元测试
- [ ] 创建基准测试

### 阶段 2：功能完善
- [ ] **Excel 导出优化** - 添加 `rust_xlsxwriter` 依赖
- [ ] **视频/音频处理** - 集成 FFmpeg 绑定
- [ ] **中文分词** - 集成 `jieba-rs` 进行更准确的词频分析
- [ ] **图片处理** - 使用 `image` crate 优化缩略图生成
- [ ] **朋友圈解密** - 实现 SnsService 的 Rust 版本

### 阶段 3：Electron 集成
- [ ] 修改根目录 `package.json` 添加 Rust 构建脚本
- [ ] 创建 TypeScript 到 Rust 的桥接层
- [ ] 逐步替换 `electron/services/` 中的服务实现
  - [ ] `imageDecryptService.ts` → Rust
  - [ ] `exportService.ts` → Rust
  - [ ] `insightService.ts` → Rust
  - [ ] `groupAnalyticsService.ts` → Rust
  - [ ] `wcdbCore.ts` → Rust（可选，需要评估收益）

### 阶段 4：性能优化
- [ ] 使用 `memmap2` 优化大文件读取
- [ ] 添加 SIMD 优化（AES-NI）
- [ ] 实现更细粒度的并行策略
- [ ] 添加 LRU 缓存层

### 阶段 5：发布准备
- [ ] 配置 CI/CD 多平台构建（GitHub Actions）
- [ ] 创建完整集成测试套件
- [ ] 编写性能对比报告
- [ ] 更新用户文档

## 性能目标

| 操作 | 当前 (TypeScript) | 目标 (Rust) | 预期提升 |
|------|-------------------|-------------|---------|
| 图片解密 (1000张) | ~30s | ~3-5s | **6-10x** |
| 消息导出 (10万条) | ~60s | ~10-15s | **4-6x** |
| 数据分析 (百万级) | ~120s | ~20-30s | **4-6x** |
| 数据库查询 (复杂) | ~2s | ~0.5-1s | **2-4x** |
| 内存占用 | ~500MB | ~200MB | **2.5x** |

## 使用指南

### 开发环境设置

```bash
# 1. 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. 进入 Rust 目录
cd rust

# 3. 安装 NAPI-RS CLI
npm install -g @napi-rs/cli

# 4. 构建开发版本
napi build --platform

# 5. 构建生产版本
napi build --platform --release
```

### 在 Electron 中使用

```javascript
// electron/main.ts
const { ImageDecryptService, ExportService, AnalyticsService } = require('../rust');

// 初始化日志
require('../rust').initLogging();

// 图片解密示例
const decryptService = new ImageDecryptService();
decryptService.setXorKey(Buffer.from([0xA3, 0xA2, 0xA1, 0xA0]));

const result = await decryptService.decryptFile(
  '/path/to/image.dat',
  '/output/directory'
);

// 导出示例
const exportService = new ExportService();
const task = exportService.createTask('export-1', {
  format: 'Html', // 'Json', 'Csv', 'Excel', 'Txt', 'ChatLab'
  outputPath: '/output/chat.html',
  includeMedia: true,
  includeAvatar: false
});

const success = await task.execute(messages, session);

// 分析示例
const analytics = new AnalyticsService();
const stats = analytics.calculateMessageStats(messages);
const yearlyReport = analytics.generateYearlyReport(messages, 2024);
```

### 渐进式替换策略

1. **第一阶段**：新增 Rust 模块，保持 TypeScript 作为 fallback
2. **第二阶段**：逐步迁移热点函数，A/B 测试性能
3. **第三阶段**：完全替换性能关键模块
4. **第四阶段**：可选：将 WCDB 核心也迁移到 Rust

## 文件映射

| TypeScript 文件 | Rust 模块 | 状态 |
|----------------|----------|------|
| `electron/services/imageDecryptService.ts` | `crypto/image.rs` | ✅ 已就绪 |
| `electron/services/exportService.ts` | `export/` | ✅ 已就绪 |
| `electron/services/insightService.ts` | `analytics/stats.rs` | ✅ 已就绪 |
| `electron/services/groupAnalyticsService.ts` | `analytics/yearly.rs` | ✅ 已就绪 |
| `electron/services/wcdbCore.ts` | `db/` | 🔄 待测试 |
| `electron/services/snsService.ts` | - | ⏳ 待开发 |

## 关键技术决策

1. **NAPI-RS vs Tauri**：选择 NAPI-RS 保持 Electron 架构，降低迁移风险
2. **Tokio vs async-std**：选择 Tokio，生态更成熟
3. **SQLite vs 其他**：保持 SQLite，与微信数据库兼容
4. **序列化**：使用 `serde` + JSON，保持与前端兼容

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 构建复杂度增加 | 中 | 提供自动化脚本和 CI/CD |
| 跨平台兼容性问题 | 中 | 早期测试 Windows/Linux 构建 |
| 性能提升不达预期 | 低 | 基准测试驱动优化，保持 fallback |
| 开发体验下降 | 低 | 提供热重载和调试配置 |

## 贡献指南

欢迎参与 Rust 重构！优先任务：

1. 编译并修复错误
2. 添加单元测试
3. 优化 Excel 导出（添加 xlsxwriter）
4. 集成中文分词（jieba-rs）
5. 性能基准测试

## 联系

项目: https://github.com/hicccc77/WeFlow
分支: `rerust`
