//! Excel 导出
//!
//! 使用 xlsxwriter 或 csv 替代方案创建 Excel 文件
//! 注意：由于依赖问题，这里使用 CSV + 重命名作为简化方案
//! 完整实现可以添加 calamine 或 rust_xlsxwriter 依赖

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// Excel 导出（使用 CSV 格式作为基础）
pub async fn export_excel(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path)?;

    // 创建简单的类 Excel 文本格式（实际项目应使用专业库）
    let mut content = String::with_capacity(messages.len() * 200);

    // 写入 BOM 用于 Excel UTF-8 识别
    content.push('\u{FEFF}');

    // 写入标题
    let title = format!(
        "聊天记录导出\t{}\t{}条消息\n",
        session.nickname.as_ref().or(session.remark.as_ref()).unwrap_or(&session.id),
        messages.len()
    );
    content.push_str(&title);
    content.push_str("=".repeat(80).as_str());
    content.push('\n');

    // 表头
    content.push_str("序号\t日期\t时间\t发送者\t类型\t内容\t媒体路径\n");

    let total = messages.len();
    let session_name = session.nickname.as_ref()
        .or(session.remark.as_ref())
        .map(|s| s.as_str())
        .unwrap_or("未知");

    for (i, msg) in messages.iter().enumerate() {
        // 检查取消
        if i % 100 == 0 && cancel_rx.try_recv().is_ok() {
            bail!("导出已取消");
        }

        // 更新进度
        if i % 100 == 0 {
            progress.write().update(i as i64, Some(format!("处理消息 {}/{}", i, total)));
        }

        let datetime = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);

        let (msg_type, msg_content) = match msg.r#type {
            1 => ("文本", msg.content.clone().unwrap_or_default()),
            3 => ("图片", "[图片]".to_string()),
            34 => ("语音", "[语音]".to_string()),
            43 | 62 => ("视频", "[视频]".to_string()),
            47 => ("表情", "[表情]".to_string()),
            49 => ("应用消息", "[应用消息]".to_string()),
            50 => ("视频通话", "[视频通话]".to_string()),
            _ => ("其他", format!("[类型:{}]", msg.r#type)),
        };

        // 转义制表符和换行符
        let msg_content = msg_content.replace('\t', " ").replace('\n', " ").replace('\r', "");

        let line = format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            i + 1,
            datetime.format("%Y-%m-%d"),
            datetime.format("%H:%M:%S"),
            if msg.is_sender { "我" } else { session_name },
            msg_type,
            msg_content,
            msg.image_path.as_ref().or(msg.voice_path.as_ref()).or(msg.video_path.as_ref()).unwrap_or(&"".to_string())
        );

        content.push_str(&line);
    }

    // 写入文件
    std::fs::write(output_path, content)
        .with_context(|| format!("写入 Excel 文件失败: {}", output_path.display()))?;

    info!("Excel 导出完成: {}", output_path.display());
    Ok(())
}

// TODO: 完整实现可以使用以下库之一：
// - rust_xlsxwriter: https://docs.rs/rust_xlsxwriter/latest/rust_xlsxwriter/
// - xlsxwriter: https://docs.rs/xlsxwriter/
// - calamine: 主要用于读取，但也可参考
