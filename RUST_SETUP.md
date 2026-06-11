# Rust 环境设置指南

## 问题
你的系统尚未安装 Rust 工具链，导致 `cargo metadata failed to run` 错误。

## 解决方案

### 1. 安装 Rust

```bash
# macOS/Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Windows
# 访问 https://rustup.rs/ 下载安装程序
```

安装完成后，重启终端并验证：

```bash
rustc --version  # 应 >= 1.75.0
cargo --version
```

### 2. 安装必要的目标平台

```bash
# macOS Universal (Intel + Apple Silicon)
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# Windows (如果需要在 macOS/Linux 上交叉编译)
rustup target add x86_64-pc-windows-msvc

# Linux
rustup target add x86_64-unknown-linux-gnu
```

### 3. 安装系统依赖

**macOS：**
```bash
xcode-select --install
```

**Ubuntu/Debian：**
```bash
sudo apt-get update
sudo apt-get install build-essential pkg-config libssl-dev
```

**Fedora/CentOS：**
```bash
sudo dnf install gcc openssl-devel
```

### 4. 安装 NAPI-RS CLI

```bash
npm install -g @napi-rs/cli
```

### 5. 构建 Rust 模块

```bash
cd rust

# 安装 npm 依赖（如果需要）
npm install

# 开发构建
napi build --platform

# 生产构建（优化）
napi build --platform --release
```

## 常见问题

### 1. `cargo metadata failed to run`

**原因：** Rust 未安装或未在 PATH 中。

**解决：**
```bash
# 检查 Rust 是否安装
which cargo
which rustc

# 如果未找到，将 Cargo bin 添加到 PATH
source $HOME/.cargo/env
```

### 2. 链接错误 `ld: library not found for -lSystem`

**原因：** macOS 缺少 Xcode Command Line Tools。

**解决：**
```bash
xcode-select --install
```

### 3. Windows 交叉编译失败

**原因：** macOS/Linux 上无法直接编译 Windows 目标（需要 MSVC）。

**解决：**
- 在 Windows 上直接构建，或
- 使用 GitHub Actions 等 CI/CD 进行多平台构建

### 4. `cannot find -lpkgconf`

**原因：** pkg-config 未安装。

**解决：**
```bash
# macOS
brew install pkg-config

# Ubuntu/Debian
sudo apt-get install pkg-config
```

## 快速测试

安装完成后，运行以下测试：

```bash
# 1. 验证 Rust 安装
rustc --version

# 2. 进入项目目录
cd rust

# 3. 检查项目（不生成二进制文件，仅检查语法）
cargo check

# 4. 如果检查通过，构建 NAPI 模块
napi build --platform

# 5. 测试加载模块
node -e "console.log(require('./index.js').version())"
```

## 下一步

成功构建后，参考 `RUST_INTEGRATION_GUIDE.md` 在 Electron 中集成 Rust 模块。
