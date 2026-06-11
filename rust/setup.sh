#!/bin/bash
# Rust 环境设置脚本

set -e

echo "🚀 WeFlow Rust Core 设置脚本"
echo "=============================="

# 检查 Rust
if ! command -v rustc &> /dev/null; then
    echo "❌ Rust 未安装，正在安装..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
else
    echo "✅ Rust 已安装: $(rustc --version)"
fi

# 添加目标平台 (macOS)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🍎 检测到 macOS，添加目标平台..."
    rustup target add aarch64-apple-darwin x86_64-apple-darwin || true
    
    # 检查 Xcode CLT
    if ! xcode-select -p &> /dev/null; then
        echo "⚠️  需要安装 Xcode Command Line Tools"
        echo "请运行: xcode-select --install"
        exit 1
    fi
fi

# 检查 NAPI-RS CLI
if ! command -v napi &> /dev/null; then
    echo "📦 安装 NAPI-RS CLI..."
    npm install -g @napi-rs/cli
else
    echo "✅ NAPI-RS CLI 已安装"
fi

echo ""
echo "🔧 构建项目..."
cargo check

echo ""
echo "📦 构建 NAPI 模块 (开发版)..."
napi build --platform

echo ""
echo "✅ 设置完成！"
echo "运行以下命令测试:"
echo "  node -e \"console.log(require('./index.js').version())\""
