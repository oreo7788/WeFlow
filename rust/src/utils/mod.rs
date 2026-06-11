//! 工具模块 - 通用工具函数

pub mod path;
pub mod time;
pub mod file;

use std::path::Path;

use anyhow::Result;

/// 初始化日志
pub fn init_logger() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("weflow_core=info")
        .try_init();
}

/// 获取文件 MIME 类型
pub fn get_mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("html") | Some("htm") => "text/html",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// 格式化时长（秒）
pub fn format_duration(seconds: i64) -> String {
    if seconds < 60 {
        format!("{}秒", seconds)
    } else if seconds < 3600 {
        format!("{}分{}秒", seconds / 60, seconds % 60)
    } else {
        format!("{}时{}分", seconds / 3600, (seconds % 3600) / 60)
    }
}

/// 格式化字节数
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;

    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }

    format!("{:.2} {}", size, UNITS[unit_idx])
}

/// 截断字符串
pub fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}

/// 驼峰命名转蛇形命名
pub fn camel_to_snake(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 2);
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                result.push('_');
            }
            result.push(c.to_lowercase().next().unwrap());
        } else {
            result.push(c);
        }
    }
    result
}
