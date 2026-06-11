//! 路径工具

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// 展开用户目录 (~)
pub fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") || path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(&path[2..])
        } else {
            PathBuf::from(path)
        }
    } else {
        PathBuf::from(path)
    }
}

/// 标准化路径
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::Normal(_) | std::path::Component::RootDir => {
                result.push(component);
            }
            _ => {}
        }
    }
    result
}

/// 获取相对路径
pub fn relative_path(from: &Path, to: &Path) -> Result<PathBuf> {
    let from = normalize_path(from);
    let to = normalize_path(to);

    let from_components: Vec<_> = from.components().collect();
    let to_components: Vec<_> = to.components().collect();

    // 找到共同前缀
    let common_len = from_components
        .iter()
        .zip(to_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut result = PathBuf::new();

    // 添加 ../ 到相对路径
    for _ in common_len..from_components.len() {
        result.push("..");
    }

    // 添加剩余路径
    for component in &to_components[common_len..] {
        result.push(component);
    }

    Ok(result)
}

/// 安全检查路径是否在指定目录内
pub fn is_path_within(base: &Path, target: &Path) -> bool {
    let base = normalize_path(base);
    let target = normalize_path(target);

    target.starts_with(&base)
}

/// 生成唯一文件名
pub fn unique_filename(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    for i in 1..10000 {
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, i)
        } else {
            format!("{}_{}.{}", stem, i, ext)
        };

        let new_path = path.with_file_name(&new_name);
        if !new_path.exists() {
            return new_path;
        }
    }

    path.to_path_buf()
}
