//! WeFlow Core - Rust 重构核心库
//! 
//! 提供高性能的微信数据处理功能：
//! - 图片/视频解密
//! - 数据导出 (HTML/JSON/CSV/Excel)
//! - 数据分析与统计
//! - 数据库操作

#![deny(clippy::all)]
#![allow(dead_code)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

// 模块声明
pub mod crypto;
pub mod db;
pub mod export;
pub mod analytics;
pub mod utils;

/// 库版本信息
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 初始化日志系统
#[napi]
pub fn init_logging() {
    tracing_subscriber::fmt::init();
}

/// 健康检查
#[napi]
pub async fn health_check() -> bool {
    true
}

/// 获取系统信息
#[napi(object)]
pub struct SystemInfo {
    pub version: String,
    pub rust_version: String,
    pub target: String,
}

#[napi]
pub fn get_system_info() -> SystemInfo {
    SystemInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: env!("RUSTC_VERSION").to_string(),
        target: env!("TARGET").to_string(),
    }
}

// ===== 错误处理 =====

/// WeFlow 错误类型
#[derive(Debug, thiserror::Error)]
pub enum WeFlowError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("Database error: {0}")]
    Database(String),
    
    #[error("Decryption error: {0}")]
    Decryption(String),
    
    #[error("Export error: {0}")]
    Export(String),
    
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    
    #[error("Not found: {0}")]
    NotFound(String),
}

impl From<WeFlowError> for napi::Error {
    fn from(err: WeFlowError) -> Self {
        napi::Error::new(napi::Status::GenericFailure, err.to_string())
    }
}

// ===== 结果类型别名 =====
pub type Result<T> = std::result::Result<T, WeFlowError>;
