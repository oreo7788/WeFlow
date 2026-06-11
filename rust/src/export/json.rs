//! JSON 导出 - 支持标准 JSON 和 ChatLab 格式

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// 标准 JSON 导出格式
#[derive(Serialize)]
struct StandardExport {
    version: String,
    export_time: String,
    session: SessionInfo,
    messages: Vec<MessageExport>,
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    name: Option<String>,
    #[serde(rename = "type")]
    session_type: i32,
    message_count: usize,
}

#[derive(Serialize)]
struct MessageExport {
    id: i64,
    local_id: i64,
    server_id: Option<String>,
    create_time: i64,
    #[serde(rename = "type")]
    msg_type: i32,
    sub_type: i32,
    is_sender: bool,
    talker: String,
    content: Option<String>,
    media_path: Option<String>,
}

/// ChatLab 格式导出
#[derive(Serialize)]
struct ChatLabExport {
    #[serde(rename = "_type")]
    type_name: String,
    version: i32,
    chat_name: String,
    messages: Vec<ChatLabMessage>,
    participants: Vec<ChatLabParticipant>,
}

#[derive(Serialize)]
struct ChatLabMessage {
    id: String,
    date: String,
    from: String,
    text: String,
    #[serde(rename = "type")]
    msg_type: String,
    media: Option<String>,
}

#[derive(Serialize)]
struct ChatLabParticipant {
    id: String,
    name: String,
    avatar: Option<String>,
}

/// 导出为标准 JSON
pub async fn export_json(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path)?;

    let session_info = SessionInfo {
        id: session.id.clone(),
        name: session.nickname.clone().or(session.remark.clone()),
        session_type: session.r#type,
        message_count: messages.len(),
    };

    let message_exports: Vec<MessageExport> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, msg)| {
            // 每100条检查一次取消
            if i % 100 == 0 && cancel_rx.try_recv().is_ok() {
                return None;
            }

            if i % 100 == 0 {
                progress.write().update(i as i64, Some(format!("处理消息 {}/{}", i, messages.len())));
            }

            Some(MessageExport {
                id: msg.id,
                local_id: msg.local_id,
                server_id: msg.server_id.clone(),
                create_time: msg.create_time,
                msg_type: msg.r#type,
                sub_type: msg.sub_type,
                is_sender: msg.is_sender,
                talker: msg.talker.clone(),
                content: msg.content.clone(),
                media_path: msg.image_path.clone().or(msg.voice_path.clone()).or(msg.video_path.clone()),
            })
        })
        .collect();

    if message_exports.len() < messages.len() {
        bail!("导出已取消");
    }

    let export = StandardExport {
        version: "1.0".to_string(),
        export_time: chrono::Local::now().to_rfc3339(),
        session: session_info,
        messages: message_exports,
    };

    let json = serde_json::to_string_pretty(&export)
        .context("序列化 JSON 失败")?;

    std::fs::write(output_path, json)
        .with_context(|| format!("写入 JSON 文件失败: {}", output_path.display()))?;

    info!("JSON 导出完成: {}", output_path.display());
    Ok(())
}

/// 导出为 ChatLab 格式
pub async fn export_chatlab(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path)?;

    // 构建参与者列表
    let participants = vec![
        ChatLabParticipant {
            id: "me".to_string(),
            name: "我".to_string(),
            avatar: None,
        },
        ChatLabParticipant {
            id: "other".to_string(),
            name: session.nickname.clone().unwrap_or_else(|| "对方".to_string()),
            avatar: None,
        },
    ];

    // 转换消息
    let chatlab_messages: Vec<ChatLabMessage> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, msg)| {
            if i % 100 == 0 && cancel_rx.try_recv().is_ok() {
                return None;
            }

            if i % 100 == 0 {
                progress.write().update(i as i64, Some(format!("处理消息 {}/{}", i, messages.len())));
            }

            let date = chrono::DateTime::from_timestamp(msg.create_time, 0)
                .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default();

            let (msg_type, text) = convert_to_chatlab_format(msg);

            Some(ChatLabMessage {
                id: msg.local_id.to_string(),
                date,
                from: if msg.is_sender { "me".to_string() } else { "other".to_string() },
                text,
                msg_type,
                media: msg.image_path.clone().or(msg.voice_path.clone()).or(msg.video_path.clone()),
            })
        })
        .collect();

    if chatlab_messages.len() < messages.len() {
        bail!("导出已取消");
    }

    let export = ChatLabExport {
        type_name: "chatlab".to_string(),
        version: 1,
        chat_name: session.nickname.clone().unwrap_or(session.id),
        messages: chatlab_messages,
        participants,
    };

    let json = serde_json::to_string_pretty(&export)
        .context("序列化 ChatLab JSON 失败")?;

    std::fs::write(output_path, json)
        .with_context(|| format!("写入 ChatLab 文件失败: {}", output_path.display()))?;

    info!("ChatLab 导出完成: {}", output_path.display());
    Ok(())
}

fn convert_to_chatlab_format(msg: &Message) -> (String, String) {
    let (msg_type, content) = match msg.r#type {
        1 => ("text".to_string(), msg.content.clone().unwrap_or_default()),
        3 => ("image".to_string(), "[图片]".to_string()),
        34 => ("voice".to_string(), "[语音]".to_string()),
        43 | 62 => ("video".to_string(), "[视频]".to_string()),
        47 => ("emoji".to_string(), "[表情]".to_string()),
        49 => ("app".to_string(), "[应用消息]".to_string()),
        50 => ("video_call".to_string(), "[视频通话]".to_string()),
        _ => ("unknown".to_string(), format!("[未知消息: {}]", msg.r#type)),
    };

    (msg_type, content)
}