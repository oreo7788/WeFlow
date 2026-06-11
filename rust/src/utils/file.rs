//! 文件工具

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use anyhow::{Context, Result};
use memmap2::Mmap;

/// 安全读取整个文件到内存
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    fs::read(path)
        .with_context(|| format!("读取文件失败: {}", path.display()))
}

/// 内存映射文件（大文件优化）
pub fn mmap_file(path: &Path) -> Result<Mmap> {
    let file = fs::File::open(path)
        .with_context(|| format!("打开文件失败: {}", path.display()))?;
    
    unsafe { Mmap::map(&file) }
        .with_context(|| format!("内存映射文件失败: {}", path.display()))
}

/// 安全写入文件
pub fn write_file(path: &Path, data: &[u8]) -> Result<()> {
    // 确保目录存在
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建目录失败: {}", parent.display()))?;
    }

    fs::write(path, data)
        .with_context(|| format!("写入文件失败: {}", path.display()))?;

    Ok(())
}

/// 计算文件 MD5
pub fn file_md5(path: &Path) -> Result<String> {
    use md5::Md5;
    use sha2::Digest;

    let data = fs::read(path)
        .with_context(|| format!("读取文件失败: {}", path.display()))?;
    
    let hash = Md5::digest(&data);
    Ok(format!("{:x}", hash))
}

/// 计算文件大小
pub fn file_size(path: &Path) -> Result<u64> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("获取文件元数据失败: {}", path.display()))?;
    Ok(metadata.len())
}

/// 判断文件是否图片
pub fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("jpg") | Some("jpeg") | Some("png") | Some("gif") | Some("webp") | Some("bmp")
    )
}

/// 判断文件是否视频
pub fn is_video(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("mp4") | Some("webm") | Some("mov") | Some("avi") | Some("mkv")
    )
}

/// 判断文件是否音频
pub fn is_audio(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("mp3") | Some("ogg") | Some("wav") | Some("m4a") | Some("aac")
    )
}

/// 递归计算目录大小
pub fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;

    for entry in walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }

    Ok(total)
}

/// 复制文件并保留元数据
pub fn copy_file_with_metadata(from: &Path, to: &Path) -> Result<()> {
    fs::copy(from, to)
        .with_context(|| format!("复制文件失败: {} -> {}", from.display(), to.display()))?;
    Ok(())
}

/// 硬链接文件
pub fn hardlink_file(original: &Path, link: &Path) -> Result<()> {
    fs::hard_link(original, link)
        .with_context(|| format!("创建硬链接失败: {} -> {}", original.display(), link.display()))?;
    Ok(())
}

/// 安全删除文件（移动到回收站或删除）
pub fn safe_delete(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    fs::remove_file(path)
        .with_context(|| format!("删除文件失败: {}", path.display()))?;

    Ok(())
}
