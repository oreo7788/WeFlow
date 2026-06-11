//! CSV 导出

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use csv::WriterBuilder;
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// CSV 记录结构
#[derive(serde::Serialize)]
struct CsvRecord {
    id: String,
    date: String,
    time: String,
    sender: String,
    #[serde(rename = "type")]
    msg_type: String,
    content: String,
    media_path: String,
    is_self: bool,
}

/// 导出为 CSV
pub async fn export_csv(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path)?;

    let file = std::fs::File::create(output_path)
        .with_context(|| format!("创建 CSV 文件失败: {}", output_path.display()))?;

    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(file);

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

        // 转换消息为 CSV 记录
        let record = convert_message_to_csv_record(msg, session_name);
        
        writer.serialize(&record)
            .with_context(|| format!("写入 CSV 记录失败: id={}", msg.id))?;
    }

    writer.flush()
        .with_context(|| "刷新 CSV 文件失败")?;

    info!("CSV 导出完成: {}", output_path.display());
    Ok(())
}

fn convert_message_to_csv_record(msg: &Message, session_name: &str) -> CsvRecord {
    let datetime = chrono::DateTime::from_timestamp(msg.create_time, 0)
        .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);

    let (msg_type, content) = match msg.r#type {
        1 => ("文本", msg.content.clone().unwrap_or_default()),
        3 => ("图片", "[图片]".to_string()),
        34 => ("语音", format!("[语音] {}", msg.content.clone().unwrap_or_default())),
        43 | 62 => ("视频", "[视频]".to_string()),
        47 => ("表情", "[表情]".to_string()),
        49 => ("应用消息", "[应用消息]".to_string()),
        50 => ("视频通话", "[视频通话]".to_string()),
        _ => ("其他", format!("[类型:{}]", msg.r#type)),
    };

    CsvRecord {
        id: msg.local_id.to_string(),
        date: datetime.format("%Y-%m-%d").to_string(),
        time: datetime.format("%H:%M:%S").to_string(),
        sender: if msg.is_sender { "我".to_string() } else { session_name.to_string() },
        msg_type: msg_type.to_string(),
        content,
        media_path: msg.image_path.clone().or(msg.voice_path.clone()).or(msg.video_path.clone()).unwrap_or_default(),
        is_self: msg.is_sender,
    }
}