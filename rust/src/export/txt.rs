//! TXT 导出

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// 导出为 TXT 纯文本格式
pub async fn export_txt(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path)?;

    let mut content = String::with_capacity(messages.len() * 150);

    // 写入标题
    let title = format!(
        "═══════════════════════════════════════════════════════════\n\
        聊天记录导出\n\
        会话: {}\n\
        消息数: {}\n\
        导出时间: {}\n\
        ═══════════════════════════════════════════════════════════\n\n",
        session.nickname.as_ref().or(session.remark.as_ref()).unwrap_or(&session.id),
        messages.len(),
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    content.push_str(&title);

    let total = messages.len();
    let session_name = session.nickname.as_ref()
        .or(session.remark.as_ref())
        .map(|s| s.as_str())
        .unwrap_or("对方");

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

        let sender = if msg.is_sender { "我" } else { session_name };

        let (msg_type, text) = match msg.r#type {
            1 => ("", msg.content.clone().unwrap_or_default()),
            3 => ("[图片]", msg.image_path.clone().unwrap_or_default()),
            34 => ("[语音]", msg.content.clone().unwrap_or_default()),
            43 | 62 => ("[视频]", msg.video_path.clone().unwrap_or_default()),
            47 => ("[表情]", "[表情]".to_string()),
            49 => ("[应用消息]", "[应用消息]".to_string()),
            50 => ("[视频通话]", "[视频通话]".to_string()),
            _ => ("", format!("[未知类型: {}]", msg.r#type)),
        };

        let line = format!(
            "[{}] {}: {} {}\n",
            datetime.format("%Y-%m-%d %H:%M:%S"),
            sender,
            msg_type,
            text
        );

        content.push_str(&line);
    }

    // 写入文件
    std::fs::write(output_path, content)
        .with_context(|| format!("写入 TXT 文件失败: {}", output_path.display()))?;

    info!("TXT 导出完成: {}", output_path.display());
    Ok(())
}
